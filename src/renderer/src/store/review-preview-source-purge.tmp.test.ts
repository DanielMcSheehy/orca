import { afterEach, expect, it, vi } from 'vitest'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { createHostTwinFixture } from './host-twin.test-fixture'
import { resetHostTwinModuleStores } from './host-twin-state-projection.test-fixture'
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
afterEach(() => vi.unstubAllGlobals())
it('clears state keyed by a purged preview source when no source tab remains', () => {
  vi.stubGlobal('window', { api: { pty: { kill: vi.fn() } } })
  const f = createHostTwinFixture('local+runtime')
  const source = 'remote-markdown-source'
  f.store.setState((s) => ({
    openFiles: s.openFiles.map((file) =>
      file.id === f.remote.fileId
        ? { ...file, mode: 'markdown-preview' as const, markdownPreviewSourceFileId: source }
        : file
    ),
    markdownFrontmatterVisible: { [source]: false }
  }))
  try {
    f.store
      .getState()
      .purgeWorktreeTerminalState([
        hostWorktreeTarget({ id: f.workspaceKey, hostId: f.remote.hostId })
      ])
    expect(f.store.getState().openFiles.some((file) => file.id === f.remote.fileId)).toBe(false)
    expect(f.store.getState().markdownFrontmatterVisible[source]).toBeUndefined()
  } finally {
    resetHostTwinModuleStores(f)
  }
})
