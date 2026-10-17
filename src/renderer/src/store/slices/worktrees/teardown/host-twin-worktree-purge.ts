import type { AppState } from '../../../types'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
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
import { removeWorktreeLayout } from '../../tabs/worktree-layout-lifecycle'
import { buildActiveSurfacePatch } from '../../tabs/tabs-surface'
import { worktreeHostMatchOptions, worktreeMatchesHost } from '../listing/worktree-host-ownership'
import { removeWorktreeVisitEntriesForTargets } from '@/lib/worktree-visit-recency'
import { collectSurfacePurgeDoomedIds } from './worktree-purge-doomed-ids'
import { createWorktreePurgeOmitters } from './worktree-purge-omitters'
import { omitRecordKeys } from './record-key-omission'
import { omitSleepingAgentSessionsForWorktrees } from './sleeping-agent-session-omission'
import {
  cancelStructuredLaunchesForWorktrees,
  retirePurgedTabLaunches
} from './purged-structured-launch-retirement'
import { buildWorktreePurgeSurfacePatch } from './worktree-purge-surface-patch'

/** Hosts outside the purge that still publish this workspace id, by the listing's host matching. */
function getSurvivingPublisherHostIds(
  s: AppState,
  workspaceId: string,
  purgedHosts: ReadonlySet<ExecutionHostId>
): ExecutionHostId[] {
  const scope = parseWorkspaceKey(workspaceId)
  if (scope?.type === 'folder') {
    const hosts = (s.folderWorkspaces ?? [])
      .filter((folder) => folder.id === scope.folderWorkspaceId)
      .map((folder) => getFolderWorkspaceHostId(folder, s.projectGroups ?? []))
    return [...new Set(hosts)].filter((hostId) => !purgedHosts.has(hostId))
  }
  const worktreeId = scope?.type === 'worktree' ? scope.worktreeId : workspaceId
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const matchOptions = new Map(
    [...purgedHosts].map((hostId) => [hostId, worktreeHostMatchOptions(s, repoId, hostId)])
  )
  // Why host matching: an unstamped legacy row or a paired runtime's SSH row is the purged copy.
  const survivors = [
    ...(s.worktreesByRepo[repoId] ?? []),
    ...(s.detectedWorktreesByRepo[repoId]?.worktrees ?? [])
  ]
    .filter(
      (row) =>
        row.id === worktreeId &&
        ![...matchOptions].some(([hostId, options]) => worktreeMatchesHost(row, hostId, options))
    )
    .map(
      (row) =>
        row.hostId ??
        (row.runtimeOwnerEnvironmentId
          ? toRuntimeExecutionHostId(row.runtimeOwnerEnvironmentId)
          : LOCAL_EXECUTION_HOST_ID)
    )
  return [...new Set(survivors)].filter((hostId) => !purgedHosts.has(hostId))
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
    const survivors = getSurvivingPublisherHostIds(s, id, purgedHosts)
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
  const tabPrefixedSleeping = {
    sleepingAgentSessionsByPaneKey: omitters.omitByPaneKeyTabPrefix(
      s.sleepingAgentSessionsByPaneKey
    ),
    agentLaunchConfigByPaneKey: omitters.omitByPaneKeyTabPrefix(s.agentLaunchConfigByPaneKey)
  }
  // Why SSH only: a record whose tab is gone names its host just by connection; null is ambiguous.
  const sshRecordPaneKeys = Object.entries(s.sleepingAgentSessionsByPaneKey ?? {}).flatMap(
    ([paneKey, record]) =>
      twinIds.has(record.worktreeId) &&
      record.connectionId &&
      canonical(record.worktreeId)(toSshExecutionHostId(record.connectionId)) === hostId
        ? [paneKey]
        : []
  )
  const layout = removeWorktreeLayout(s, {
    worktreeIds: new Set(),
    tabIds: doomed.doomedTabIds,
    activeFileCleared: s.activeFileId != null && removed.fileIds.has(s.activeFileId),
    kept: {
      worktreeIds: twinIds,
      terminalTabIds: removed.terminalTabIds,
      fileIds: removed.fileIds,
      browserTabIds: removed.browserTabIds,
      unifiedTabIds: removed.otherTabIds
    }
  })
  const removedAny = [
    removed.terminalTabIds,
    removed.fileIds,
    removed.browserTabIds,
    removed.otherTabIds
  ].some((ids) => ids.size > 0)
  const activeTwinId =
    removedAny && s.activeWorktreeId && twinIds.has(s.activeWorktreeId) ? s.activeWorktreeId : null
  return {
    ...layout,
    // Why: a group may now show a surviving tab of another kind, so selection is derived again.
    ...(activeTwinId ? buildActiveSurfacePatch({ ...s, ...layout }, activeTwinId) : {}),
    ...buildWorktreePurgeSurfacePatch(s, omitters, doomed.doomedTabIds, {
      ...tabPrefixedSleeping,
      ...omitSleepingAgentSessionsForWorktrees(tabPrefixedSleeping, new Set(), sshRecordPaneKeys)
    }),
    deleteStateByWorktreeId: omitRecordKeys(
      s.deleteStateByWorktreeId,
      [...twinIds].map((id) => composeWorktreeHostIdentity(hostId, id))
    ),
    lastVisitedAtByWorktreeId: removeWorktreeVisitEntriesForTargets(
      s.lastVisitedAtByWorktreeId,
      [...twinIds].map((id) => ({ id, hostId }))
    ),
    ...twinSelectionPatch(s, twinHostIds, hostId)
  }
}
