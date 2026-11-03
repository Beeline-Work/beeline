// Keep synchronous source analysis outside Vitest's event loop so its caller
// can stop a stuck scan without consuming the server shard's job deadline.
import { parentPort, workerData } from 'node:worker_threads';
import { tsImport } from 'tsx/esm/api';
const { scanSystemMessageWording } = await tsImport('./system-message-scan.ts', import.meta.url);
const { assertCatalogUsage } = await tsImport('./system-message-guard.ts', import.meta.url);
assertCatalogUsage(scanSystemMessageWording(new Map(workerData)));
parentPort.postMessage('passed');
