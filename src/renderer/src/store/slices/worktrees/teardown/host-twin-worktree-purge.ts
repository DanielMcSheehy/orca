import type { AppState } from '../../../types'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../../../../shared/worktree/id'
import { composeWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { WorktreePurgeTarget } from '../../worktree-purge-target'
import { getFolderWorkspaceHostId } from '../../../folder-workspaces/folder-workspace-catalog'
import {
  collectRemovedHostTwinState,
  removedHostCanonicalizer
} from '../../../repos/repo-removal-host-twin-attribution'
import { twinSelectionPatch } from '../../../repos/repo-removal-host-twin-teardown'
import { removeSurfacesFromWorktreeLayout } from '../../tabs/worktree-surface-layout-removal'
import { removeWorktreeVisitEntriesForTargets } from '@/lib/worktree-visit-recency'
import { collectSurfacePurgeDoomedIds } from './worktree-purge-doomed-ids'
import { createWorktreePurgeOmitters } from './worktree-purge-omitters'
import { omitRecordKeys } from './record-key-omission'
import {
  cancelStructuredLaunchesForWorktrees,
  retirePurgedTabLaunches
} from './purged-structured-launch-retirement'
import { buildWorktreePurgeSurfacePatch } from './worktree-purge-surface-patch'

/** Hosts that publish this workspace id, from repo worktree rows or folder workspace rows. */
function getWorkspacePublisherHostIds(s: AppState, workspaceId: string): Set<ExecutionHostId> {
  const scope = parseWorkspaceKey(workspaceId)
  if (scope?.type === 'folder') {
    return new Set(
      (s.folderWorkspaces ?? [])
        .filter((folder) => folder.id === scope.folderWorkspaceId)
        .map((folder) => getFolderWorkspaceHostId(folder, s.projectGroups ?? []))
    )
  }
  const worktreeId = scope?.type === 'worktree' ? scope.worktreeId : workspaceId
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  return new Set(
    [...(s.worktreesByRepo[repoId] ?? []), ...(s.detectedWorktreesByRepo[repoId]?.worktrees ?? [])]
      .filter((row) => row.id === worktreeId)
      .map((row) => row.hostId ?? LOCAL_EXECUTION_HOST_ID)
  )
}

/**
 * Per purged host, its target ids that a host outside the purge still publishes, with those
 * hosts. A raw-id target for the same id wins: it already purges every bucket.
 */
export function collectHostTwinPurgeScopes(
  s: AppState,
  targets: readonly WorktreePurgeTarget[]
): Map<ExecutionHostId, Map<string, ExecutionHostId[]>> {
  const rawIds = new Set(targets.filter((target) => !target.hostId).map((target) => target.id))
  const purgedHostsById = new Map<string, Set<ExecutionHostId>>()
  for (const { id, hostId } of targets) {
    if (hostId && !rawIds.has(id)) {
      purgedHostsById.set(id, (purgedHostsById.get(id) ?? new Set()).add(hostId))
    }
  }
  const scopes = new Map<ExecutionHostId, Map<string, ExecutionHostId[]>>()
  for (const [id, purgedHosts] of purgedHostsById) {
    const survivors = [...getWorkspacePublisherHostIds(s, id)].filter(
      (hostId) => !purgedHosts.has(hostId)
    )
    if (survivors.length === 0) {
      continue
    }
    for (const hostId of purgedHosts) {
      const scope = scopes.get(hostId) ?? new Map<string, ExecutionHostId[]>()
      scopes.set(hostId, scope.set(id, survivors))
    }
  }
  return scopes
}

/**
 * Purges one host's attributable surfaces under ids a twin still publishes. Worktree-keyed
 * buckets, raw-id module stores and surfaces with no host evidence stay: they may be the twin's.
 */
export function buildHostTwinPurgeState(
  s: AppState,
  hostId: ExecutionHostId,
  twinHostIds: ReadonlyMap<string, readonly ExecutionHostId[]>
): Partial<AppState> {
  const twinIds = new Set(twinHostIds.keys())
  const removed = collectRemovedHostTwinState(s, twinIds, hostId, twinHostIds)
  const canonical = (worktreeId: string) =>
    removedHostCanonicalizer(s, worktreeId, hostId, twinHostIds.get(worktreeId) ?? [])
  const cancelledSessionIds = cancelStructuredLaunchesForWorktrees(
    twinIds,
    (worktreeId, launchHostId) => canonical(worktreeId)(launchHostId) === hostId
  )
  const terminalTabs: { id: string; ptyId: string | null }[] = []
  for (const worktreeId of twinIds) {
    const legacyTabs = (s.tabsByWorktree[worktreeId] ?? []).filter((tab) =>
      removed.terminalTabIds.has(tab.id)
    )
    terminalTabs.push(...legacyTabs)
    retirePurgedTabLaunches(
      s,
      worktreeId,
      legacyTabs,
      (s.unifiedTabsByWorktree[worktreeId] ?? []).filter((tab) => removed.otherTabIds.has(tab.id)),
      cancelledSessionIds
    )
  }
  // Why: a hydrated terminal can exist only as a unified tab, with no legacy row.
  for (const tabId of removed.terminalTabIds) {
    if (!terminalTabs.some((tab) => tab.id === tabId)) {
      terminalTabs.push({ id: tabId, ptyId: null })
    }
  }
  const doomed = collectSurfacePurgeDoomedIds(s, {
    tabs: terminalTabs,
    browserWorkspaceIds: removed.browserTabIds,
    fileIds: removed.fileIds
  })
  const omitters = createWorktreePurgeOmitters(s, new Set(), doomed)
  const deleteStateKeys = [...twinIds].map((id) => composeWorktreeHostIdentity(hostId, id))
  return {
    ...removeSurfacesFromWorktreeLayout(s, twinIds, {
      terminalTabIds: removed.terminalTabIds,
      fileIds: removed.fileIds,
      browserTabIds: removed.browserTabIds,
      unifiedTabIds: removed.otherTabIds
    }),
    // Why tab-prefixed only: a sleeping record matched by worktree id alone may be the twin's.
    ...buildWorktreePurgeSurfacePatch(s, omitters, doomed.doomedTabIds, {
      sleepingAgentSessionsByPaneKey: omitters.omitByPaneKeyTabPrefix(
        s.sleepingAgentSessionsByPaneKey
      ),
      agentLaunchConfigByPaneKey: omitters.omitByPaneKeyTabPrefix(s.agentLaunchConfigByPaneKey)
    }),
    deleteStateByWorktreeId: omitRecordKeys(s.deleteStateByWorktreeId, deleteStateKeys),
    lastVisitedAtByWorktreeId: removeWorktreeVisitEntriesForTargets(
      s.lastVisitedAtByWorktreeId,
      [...twinIds].map((id) => ({ id, hostId }))
    ),
    ...twinSelectionPatch(s, twinHostIds, hostId)
  }
}
