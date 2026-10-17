import type { AppState } from '@/store/types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { buildExecutionHostRegistry } from '../../../../shared/execution-host-registry'
import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../shared/worktree/types'
import { normalizeWorktreePurgeTarget } from '@/store/slices/worktree-purge-target'
import { collectHostTwinPurgeScopes } from '@/store/slices/worktrees/teardown/host-twin-worktree-purge'
import { getHostDisplayLabelOverrides } from '../../../../shared/host-setting-overrides'

/**
 * Hosts whose copy of a selected workspace the sleep also reaches without being named: a twin
 * shares one id, so sleeping either copy sleeps the whole workspace.
 */
export function collectTwinHostsAlsoSlept(
  state: AppState,
  worktrees: readonly Pick<Worktree, 'id' | 'hostId'>[]
): ExecutionHostId[] {
  // Why stamped rows only: an unstamped legacy row names no host, so nothing can be confirmed.
  const targets = worktrees.flatMap((worktree) =>
    worktree.hostId
      ? [
          normalizeWorktreePurgeTarget(
            hostWorktreeTarget({ id: worktree.id, hostId: worktree.hostId })
          )
        ]
      : []
  )
  const alsoSlept = new Set<ExecutionHostId>()
  for (const twins of collectHostTwinPurgeScopes(state, targets).byHost.values()) {
    for (const hostIds of twins.values()) {
      for (const hostId of hostIds) {
        alsoSlept.add(hostId)
      }
    }
  }
  return [...alsoSlept]
}

/** User-facing names for hosts, as the sidebar shows them. */
export function labelExecutionHosts(
  state: AppState,
  hostIds: readonly ExecutionHostId[]
): string[] {
  const labels = new Map(
    buildExecutionHostRegistry({
      repos: state.repos,
      settings: state.settings,
      sshTargetLabels: state.sshTargetLabels,
      runtimeEnvironments: state.runtimeEnvironments,
      hostLabelOverrides: getHostDisplayLabelOverrides(state.settings)
    }).map((entry) => [entry.id, entry.label])
  )
  return hostIds.map((hostId) => labels.get(hostId) ?? hostId)
}
