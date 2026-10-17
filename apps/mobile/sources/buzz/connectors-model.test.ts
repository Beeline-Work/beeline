import { expect, it } from 'vitest';
import { workbenchSummary } from './connectors-model';
import type { WorkbenchView } from './workbench';
const view: WorkbenchView = { connectors: [], helpers: [], apps: [], connections: [] };
it('uses the server summary unchanged, without counting client records', () => {
  const summary = { value: '3 connections', attention: '1 company needs attention' };
  expect(workbenchSummary({ ...view, companies: { version: 1, rows: [], suggestions: [], hasConnections: true, summary } }, 'owner')).toBe(summary);
  expect(workbenchSummary(view, 'owner')).toEqual({ value: 'Unavailable' });
});
