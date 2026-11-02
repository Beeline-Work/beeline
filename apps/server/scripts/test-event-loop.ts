import { setImmediate } from 'node:timers/promises';
import { afterEach } from 'vitest';

// PGlite's WASM queries can resolve entirely through microtasks. A long chain
// of otherwise short tests then starves IPC: Vitest's progress RPC expires
// before the worker can read its response. Let I/O run between tests rather
// than extending the RPC timeout or hiding unhandled errors. Use Node's real
// scheduler so a suite's fake timers cannot prevent the yield.
afterEach(() => setImmediate());
