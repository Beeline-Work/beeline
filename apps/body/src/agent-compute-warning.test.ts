import { expect, it } from 'vitest';
import { agentComputeWarning } from './agent-compute-warning.js';
const gib = 1024 ** 3;
it('warns on memory or CPU pressure and always says setup continues', () => {
  expect(agentComputeWarning(2, 8 * gib, 4)).toBeUndefined();
  expect(agentComputeWarning(16, 8 * gib, 16)).toContain('Setup will continue.');
  expect(agentComputeWarning(10, 64 * gib, 2)).toContain('2 CPU cores');
});
