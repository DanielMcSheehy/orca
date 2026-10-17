import type { AppState } from '../../types'
import { toVisibleTabType, type Tab, type TabGroup } from '../../../../../shared/tab-types'
import { omitRecordKeys } from '../worktrees/teardown/record-key-omission'
import { sanitizeRecentTabIds } from '../tab-group-state'

export type RemovedWorktreeSurfaces = {
  terminalTabIds: ReadonlySet<string>
  fileIds: ReadonlySet<string>
  browserTabIds: ReadonlySet<string>
  /** Unified tab ids of non-file surfaces such as chats. */
  unifiedTabIds: ReadonlySet<string>
}

function isRemovedUnifiedTab(tab: Tab, removed: RemovedWorktreeSurfaces): boolean {
  if (removed.unifiedTabIds.has(tab.id)) {
    return true
  }
  if (tab.contentType === 'terminal') {
    return removed.terminalTabIds.has(tab.entityId)
  }
  if (tab.contentType === 'browser') {
    return removed.browserTabIds.has(tab.entityId)
  }
  return toVisibleTabType(tab.contentType) === 'editor' && removed.fileIds.has(tab.entityId)
}

function pruneGroup(group: TabGroup, removedIds: ReadonlySet<string>): TabGroup {
  if (!group.tabOrder.some((id) => removedIds.has(id))) {
    return group
  }
  const tabOrder = group.tabOrder.filter((id) => !removedIds.has(id))
  const recentTabIds = sanitizeRecentTabIds(group.recentTabIds, tabOrder)
  const activeTabId =
    group.activeTabId && removedIds.has(group.activeTabId)
      ? (recentTabIds.at(-1) ?? tabOrder[0] ?? null)
      : group.activeTabId
  return {
    ...group,
    tabOrder,
    activeTabId,
    ...(group.recentTabIds ? { recentTabIds } : {})
  }
}

/**
 * Drops named surfaces from workspaces that stay, such as one host's tabs under an id its twin
 * still publishes. Worktree-keyed buckets keep their entry; only the removed surfaces leave it.
 */
export function removeSurfacesFromWorktreeLayout(
  s: AppState,
  worktreeIds: ReadonlySet<string>,
  removed: RemovedWorktreeSurfaces
): Partial<AppState> {
  const tabsByWorktree = { ...s.tabsByWorktree }
  const unifiedTabsByWorktree = { ...s.unifiedTabsByWorktree }
  const groupsByWorktree = { ...s.groupsByWorktree }
  const browserTabsByWorktree = { ...s.browserTabsByWorktree }
  const tabBarOrderByWorktree = { ...s.tabBarOrderByWorktree }
  const activeTabIdByWorktree = { ...s.activeTabIdByWorktree }
  const activeFileIds: string[] = []
  const activeBrowserIds: string[] = []
  for (const worktreeId of worktreeIds) {
    const removedUnifiedIds = new Set(
      (s.unifiedTabsByWorktree[worktreeId] ?? [])
        .filter((tab) => isRemovedUnifiedTab(tab, removed))
        .map((tab) => tab.id)
    )
    const removedIds = new Set([
      ...removedUnifiedIds,
      ...removed.terminalTabIds,
      ...removed.fileIds,
      ...removed.browserTabIds
    ])
    if (s.tabsByWorktree[worktreeId]) {
      tabsByWorktree[worktreeId] = s.tabsByWorktree[worktreeId].filter(
        (tab) => !removed.terminalTabIds.has(tab.id)
      )
    }
    if (s.unifiedTabsByWorktree[worktreeId]) {
      unifiedTabsByWorktree[worktreeId] = s.unifiedTabsByWorktree[worktreeId].filter(
        (tab) => !removedUnifiedIds.has(tab.id)
      )
    }
    if (s.groupsByWorktree[worktreeId]) {
      groupsByWorktree[worktreeId] = s.groupsByWorktree[worktreeId].map((group) =>
        pruneGroup(group, removedIds)
      )
    }
    if (s.browserTabsByWorktree[worktreeId]) {
      browserTabsByWorktree[worktreeId] = s.browserTabsByWorktree[worktreeId].filter(
        (workspace) => !removed.browserTabIds.has(workspace.id)
      )
    }
    if (s.tabBarOrderByWorktree[worktreeId]) {
      tabBarOrderByWorktree[worktreeId] = s.tabBarOrderByWorktree[worktreeId].filter(
        (id) => !removedIds.has(id)
      )
    }
    const activeTabId = s.activeTabIdByWorktree[worktreeId]
    if (activeTabId && removed.terminalTabIds.has(activeTabId)) {
      activeTabIdByWorktree[worktreeId] = tabsByWorktree[worktreeId]?.[0]?.id ?? null
    }
    const activeFileId = s.activeFileIdByWorktree[worktreeId]
    if (activeFileId && removed.fileIds.has(activeFileId)) {
      activeFileIds.push(worktreeId)
    }
    const activeBrowserId = s.activeBrowserTabIdByWorktree[worktreeId]
    if (activeBrowserId && removed.browserTabIds.has(activeBrowserId)) {
      activeBrowserIds.push(worktreeId)
    }
  }
  const activeFileCleared = s.activeFileId != null && removed.fileIds.has(s.activeFileId)
  const activeBrowserCleared =
    s.activeBrowserTabId != null && removed.browserTabIds.has(s.activeBrowserTabId)
  const surfaceTypeCleared =
    (activeFileCleared && s.activeTabType === 'editor') ||
    (activeBrowserCleared && s.activeTabType === 'browser')
  return {
    tabsByWorktree,
    terminalLayoutsByTabId: omitRecordKeys(s.terminalLayoutsByTabId, removed.terminalTabIds),
    ptyIdsByTabId: omitRecordKeys(s.ptyIdsByTabId, removed.terminalTabIds),
    unifiedTabsByWorktree,
    groupsByWorktree,
    browserTabsByWorktree,
    tabBarOrderByWorktree,
    activeTabIdByWorktree,
    activeFileIdByWorktree: omitRecordKeys(s.activeFileIdByWorktree, activeFileIds),
    activeBrowserTabIdByWorktree: omitRecordKeys(s.activeBrowserTabIdByWorktree, activeBrowserIds),
    openFiles: s.openFiles.some((file) => removed.fileIds.has(file.id))
      ? s.openFiles.filter((file) => !removed.fileIds.has(file.id))
      : s.openFiles,
    activeTabId: s.activeTabId && removed.terminalTabIds.has(s.activeTabId) ? null : s.activeTabId,
    activeFileId: activeFileCleared ? null : s.activeFileId,
    activeBrowserTabId: activeBrowserCleared ? null : s.activeBrowserTabId,
    activeTabType: surfaceTypeCleared ? 'terminal' : s.activeTabType
  }
}
