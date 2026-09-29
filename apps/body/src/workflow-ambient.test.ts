import { expect, it } from 'vitest';
import { workflowAmbient } from './workflow-ambient.js';

it('puts a relevant workflow and active run in the turn list', () => {
  const listed = workflowAmbient(
    [
      {
        name: 'alpha',
        purpose: 'Sort inbox',
        trigger: { kind: 'manual' },
        layer: 'room',
        version: 1,
      },
      {
        name: 'code-corner',
        purpose: 'Review a pull request',
        trigger: { kind: 'manual' },
        layer: 'built-in',
        version: 1,
      },
    ],
    [{ runId: 'run-1', name: 'code-corner', revision: 1, state: 'review', status: 'waiting' }],
    'Please review this pull request',
  );
  expect(listed.indexOf('open run run-1')).toBeLessThan(listed.indexOf('code-corner (built-in'));
  expect(listed.indexOf('code-corner (built-in')).toBeLessThan(listed.indexOf('alpha (room'));
});
