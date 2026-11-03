import { setImmediate } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, beforeEach, onTestFailed, vi } from 'vitest';

// Temporary CI evidence for the intermittent single-fork scheduler failure.
// Observe state without draining work, restoring clocks, or installing timers:
// doing any of those here could hide the failure we need to capture.
if (process.env.SERVER_TIMER_DIAGNOSTICS === '1') {
  const timerState = (timer: typeof globalThis.setTimeout | typeof globalThis.setImmediate) =>
    'clock' in timer;
  const snapshot = (phase: string, file: string, test?: string) => {
    const handles = (process as typeof process & {
      _getActiveHandles?: () => Array<{
        constructor?: { name?: string }; hasRef?: () => boolean;
        destroyed?: boolean; listening?: boolean;
      }>;
    })._getActiveHandles?.() ?? [];
    const resources: Record<string, number> = {};
    for (const resource of process.getActiveResourcesInfo()) resources[resource] = (resources[resource] ?? 0) + 1;
    const fakeTimers = vi.isFakeTimers();
    console.error('[server-timer-diagnostic]', JSON.stringify({
      phase, file, test, pid: process.pid, fakeTimers,
      fakeTimerCount: fakeTimers ? vi.getTimerCount() : undefined,
      timeoutMocked: timerState(globalThis.setTimeout),
      immediateMocked: timerState(globalThis.setImmediate),
      resources,
      handles: handles.map(handle => ({
        type: handle.constructor?.name, ref: handle.hasRef?.(),
        destroyed: handle.destroyed, listening: handle.listening,
      })),
    }));
  };
  beforeAll(suite => snapshot('file-start', suite.file.filepath));
  afterAll(suite => snapshot('file-end', suite.file.filepath));
  beforeEach(context => {
    onTestFailed(() => snapshot('test-failed', context.task.file.filepath, context.task.name));
  });
}

// PGlite's WASM queries can resolve entirely through microtasks. A long chain
// of otherwise short tests then starves IPC: Vitest's progress RPC expires
// before the worker can read its response. Let I/O run between tests rather
// than extending the RPC timeout or hiding unhandled errors. Use Node's real
// scheduler so a suite's fake timers cannot prevent the yield.
afterEach(() => setImmediate());
