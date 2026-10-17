import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { getWorktreeVisitKey } from '@/lib/worktree-visit-recency'
import { hasWorktreeSleepIntent } from '@/lib/worktree-sleep-intent'
import { resetHostTwinModuleStores } from './host-twin-state-projection.test-fixture'
import { createHostTwinFixture, type HostTwinFixture } from './host-twin.test-fixture'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

let current: HostTwinFixture | null = null

beforeEach(() => {
  vi.stubGlobal('window', { api: { pty: { kill: vi.fn() } } })
})

afterEach(() => {
  if (current) {
    resetHostTwinModuleStores(current)
  }
  current = null
  vi.unstubAllGlobals()
})

function twin(kind: Parameters<typeof createHostTwinFixture>[0] = 'local+ssh'): HostTwinFixture {
  const fixture = createHostTwinFixture(kind)
  current = fixture
  const key = fixture.workspaceKey
  fixture.store.setState({
    gitStatusByWorktree: { [key]: [] },
    activeWorktreeId: key,
    activeWorkspaceExecutionHostId: fixture.remote.hostId,
    lastVisitedAtByWorktreeId: {
      [getWorktreeVisitKey(key, fixture.local.hostId)]: 1,
      [getWorktreeVisitKey(key, fixture.remote.hostId)]: 2
    }
  })
  return fixture
}

function keepOnlyRemoteRow(fixture: HostTwinFixture): void {
  fixture.store.setState((s) => ({
    worktreesByRepo: {
      [fixture.projectId]: (s.worktreesByRepo[fixture.projectId] ?? []).filter(
        (row) => row.hostId === fixture.remote.hostId
      )
    }
  }))
}

describe('purgeWorktreeTerminalState with a surviving twin', () => {
  it("purges only the target host's attributable state", () => {
    const f = twin()
    const key = f.workspaceKey

    f.store.getState().purgeWorktreeTerminalState([hostWorktreeTarget({ id: key, ...f.remote })])

    const s = f.store.getState()
    expect(s.tabsByWorktree[key]?.map((tab) => tab.id)).toEqual([
      f.local.terminalTabId,
      f.dormantTabId
    ])
    expect(s.ptyIdsByTabId[f.remote.terminalTabId]).toBeUndefined()
    expect(s.terminalLayoutsByTabId[f.remote.terminalTabId]).toBeUndefined()
    expect(s.ptyIdsByTabId[f.local.terminalTabId]).toEqual([f.local.ptyId])
    expect(s.unifiedTabsByWorktree[key]?.map((tab) => tab.id)).toEqual([
      f.local.terminalTabId,
      f.local.fileId,
      f.dormantTabId
    ])
    expect(s.groupsByWorktree[key]?.[0]?.tabOrder).toEqual([
      f.local.terminalTabId,
      f.local.fileId,
      f.dormantTabId
    ])
    expect(s.openFiles.map((file) => file.id)).toEqual([f.local.fileId])
    expect(Object.keys(s.editorDrafts)).toEqual([f.local.fileId])
    expect(Object.keys(s.sleepingAgentSessionsByPaneKey)).toEqual([f.local.paneKey])
    // Shared buckets and raw-id module stores cannot name a host, so the twin keeps them.
    expect(s.gitStatusByWorktree[key]).toEqual([])
    expect(hasWorktreeSleepIntent(key)).toBe(true)
    expect(Object.keys(s.lastVisitedAtByWorktreeId)).toEqual([
      getWorktreeVisitKey(key, f.local.hostId)
    ])
    expect(s.activeWorktreeId).toBe(key)
    expect(s.activeWorkspaceExecutionHostId).toBe(f.local.hostId)
  })

  it('keeps the runtime twin when the local copy is purged', () => {
    const f = twin('local+runtime')
    const key = f.workspaceKey

    f.store.getState().purgeWorktreeTerminalState([hostWorktreeTarget({ id: key, ...f.local })])

    const s = f.store.getState()
    expect(s.tabsByWorktree[key]?.map((tab) => tab.id)).toEqual([
      f.remote.terminalTabId,
      f.dormantTabId
    ])
    expect(s.openFiles.map((file) => file.id)).toEqual([f.remote.fileId])
  })

  it('purges everything when no other host publishes the id', () => {
    const f = twin()
    const key = f.workspaceKey
    keepOnlyRemoteRow(f)

    f.store.getState().purgeWorktreeTerminalState([hostWorktreeTarget({ id: key, ...f.remote })])

    const s = f.store.getState()
    expect(s.tabsByWorktree[key]).toBeUndefined()
    expect(s.openFiles).toEqual([])
    expect(s.gitStatusByWorktree[key]).toBeUndefined()
    expect(hasWorktreeSleepIntent(key)).toBe(false)
    // Recency stays host-scoped, as before.
    expect(Object.keys(s.lastVisitedAtByWorktreeId)).toEqual([
      getWorktreeVisitKey(key, f.local.hostId)
    ])
  })

  it('purges everything when every publishing host is targeted', () => {
    const f = twin()
    const key = f.workspaceKey

    f.store
      .getState()
      .purgeWorktreeTerminalState([
        hostWorktreeTarget({ id: key, ...f.remote }),
        hostWorktreeTarget({ id: key, ...f.local })
      ])

    expect(f.store.getState().tabsByWorktree[key]).toBeUndefined()
    expect(f.store.getState().gitStatusByWorktree[key]).toBeUndefined()
  })

  it('keeps the raw-id purge reaching both twins', () => {
    const f = twin()
    const key = f.workspaceKey

    f.store.getState().purgeWorktreeTerminalState([key])

    const s = f.store.getState()
    expect(s.tabsByWorktree[key]).toBeUndefined()
    expect(s.openFiles).toEqual([])
    expect(s.lastVisitedAtByWorktreeId).toEqual({})
  })
})
