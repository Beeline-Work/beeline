import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentUsageCell } from '@beeline/api-contract/helper-usage';
import { resetClientState } from '@/sync/client-reset';
import { installUsageCellConnection, isUsageCellOnlyChange, receiveUsageCell, setUsageCellProfile,
subscribeUsageCell, suspendUsageCellConnection, usageCellSnapshot } from './agent-usage-cell';
import { useAgentUsageCell } from './use-agent-usage-cell';
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native', () => ({ Text: 'Text', View: 'View', ActivityIndicator: 'ActivityIndicator', AccessibilityInfo: { announceForAccessibility: vi.fn() } }));
vi.mock('react-native-unistyles', () => ({ StyleSheet: { create: (factory: (theme: unknown) => unknown) => factory({ buzz: { space: {}, type: {} } }), hairlineWidth: 1 } }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/components/buzz/IndexRow', () => ({ InlineRow: 'InlineRow' }));
vi.mock('@/components/buzz/Button', () => ({ Button: 'Button' }));
vi.mock('@/components/buzz/RoomListSectionHeader', () => ({ RoomListSectionHeader: 'RoomListSectionHeader' }));
import { AgentUsageSection } from '@/components/buzz/AgentUsageSection';
const principal = 'a'.repeat(64);const agentId = 'b'.repeat(64);
function fact(revision: number, used = 0.14): AgentUsageCell {
  return { v: 1, agentId, ownerId: principal, generation: '1'.repeat(32), revision, allowed: true,
    usage: { updatedAt: 100 + revision, windows: [{ rateLimitType: 'five_hour', status: 'allowed', utilization: used, updatedAt: 100 + revision }], context: { used: 1234, size: 10000 } } };
}
const drain = async () => {for (let i = 0; i < 30; i++) await Promise.resolve();};
const installed = (executeRead: (id: string) => Promise<AgentUsageCell>, generation = 1, usageCellV1 = true) =>
installUsageCellConnection({ generation, usageCellV1, origin: 'https://synthetic.test', principal, executeRead });
beforeEach(() => {resetClientState();(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?: boolean;}).IS_REACT_ACT_ENVIRONMENT = true;});
afterEach(() => {resetClientState();vi.restoreAllMocks();});
describe('independent canonical usage cells', () => {
  it('only committed profile selection reads; subscribe/remount and repeated selection cannot replenish it', async () => {
    const read = vi.fn(async () => fact(1));installed(read);
    const stop = subscribeUsageCell(() => {});stop();subscribeUsageCell(() => {})();
    await drain();expect(read).not.toHaveBeenCalled();
    setUsageCellProfile(agentId);setUsageCellProfile(agentId);await drain();
    expect(read).toHaveBeenCalledTimes(1);expect(usageCellSnapshot(agentId).cell).toEqual(fact(1));
    setUsageCellProfile(null);expect(usageCellSnapshot(agentId).cell).toBeNull();
  });
  it('a source arriving before the baseline waits for a fresh read and then wins by revision', async () => {
    const executeRead = vi.fn(async () => fact(1)); const joinedRead = vi.fn();
    installUsageCellConnection({ generation: 1, usageCellV1: true, origin: 'https://synthetic.test', principal, executeRead, joinedRead });
    setUsageCellProfile(agentId); receiveUsageCell(fact(2)); await drain();
    expect(executeRead).toHaveBeenCalledTimes(1); expect(joinedRead).not.toHaveBeenCalled();
    expect(usageCellSnapshot(agentId).cell?.revision).toBe(2);
  });
  it('a newer source cell wins over an older pending initial snapshot without a profile read', async () => {
    let resolve!: (cell: AgentUsageCell) => void;
    const read = vi.fn(() => new Promise<AgentUsageCell>((done) => {resolve = done;}));installed(read);setUsageCellProfile(agentId);
    await drain();receiveUsageCell(fact(2, 0.42));resolve(fact(1));await drain();
    expect(usageCellSnapshot(agentId).cell).toEqual(fact(2, 0.42));expect(read).toHaveBeenCalledTimes(1);
  });
  it('revoke fences delayed private cells; a newer canonical regrant supplies the complete replacement', async () => {
    installed(async () => fact(1));setUsageCellProfile(agentId);await drain();
    receiveUsageCell({ ...fact(2), allowed: false, usage: undefined });
    expect(usageCellSnapshot(agentId).cell?.allowed).toBe(false);
    receiveUsageCell(fact(1));expect(usageCellSnapshot(agentId).cell?.allowed).toBe(false);
    receiveUsageCell({ ...fact(3, 0.6), generation: '2'.repeat(32) });
    expect(usageCellSnapshot(agentId).cell).toEqual({ ...fact(3, 0.6), generation: '2'.repeat(32) });
    receiveUsageCell({ ...fact(2), allowed: false, usage: undefined });
    expect(usageCellSnapshot(agentId).cell?.revision).toBe(3);
  });
  it('foreign owner, malformed cell and unsupported generation cannot replace a validated answer', async () => {
    installed(async () => fact(1));setUsageCellProfile(agentId);await drain();
    receiveUsageCell({ ...fact(2), ownerId: 'foreign' });
    receiveUsageCell({ ...fact(1), generation: 'forged' });
    receiveUsageCell({ ...fact(1), usage: undefined });
    expect(usageCellSnapshot(agentId).cell).toEqual(fact(1));
  });
  it('malformed current-reader data parks only its affected private cell and fences an older in-flight answer', async () => {
    let resolve!: (cell: AgentUsageCell) => void;
    installed(() => new Promise((done) => {resolve = done;}));setUsageCellProfile(agentId);await drain();
    receiveUsageCell(fact(2));receiveUsageCell({ ...fact(3), generation: 'invalid', allowed: false });
    resolve(fact(1));await drain();receiveUsageCell(fact(2));
    expect(usageCellSnapshot(agentId)).toEqual({ mode: 'pending', cell: null });
    installed(async () => fact(4), 2);await drain();expect(usageCellSnapshot(agentId).cell?.revision).toBe(4);
  });
  it('disconnection and identity change hide the cell and fence late replies', async () => {
    let resolve!: (cell: AgentUsageCell) => void;installed(() => new Promise((done) => {resolve = done;}));
    setUsageCellProfile(agentId);await drain();suspendUsageCellConnection();resolve(fact(1));await drain();
    expect(usageCellSnapshot(agentId)).toEqual({ mode: 'pending', cell: null });
    resetClientState();installed(async () => fact(1));setUsageCellProfile(agentId);await drain();
    expect(usageCellSnapshot(agentId).cell?.ownerId).toBe(principal);
    resetClientState();expect(usageCellSnapshot(agentId).cell).toBeNull();
  });
  it('an old negotiation cannot downgrade or replenish a newer suspended family', async () => {
    const read = vi.fn(async () => fact(1));installed(read, 2, true);setUsageCellProfile(agentId);await drain();
    suspendUsageCellConnection();installed(read, 1, false);installed(read, 2, true);await drain();
    expect(usageCellSnapshot(agentId)).toEqual({ mode: 'pending', cell: null });expect(read).toHaveBeenCalledTimes(1);
    installed(read, 3, true);await drain();expect(read).toHaveBeenCalledTimes(2);
  });
  it('legacy selection has one active path and retains compatibility hints', async () => {
    const read = vi.fn(async () => fact(1));installed(read, 1, false);setUsageCellProfile(agentId);await drain();
    expect(read).not.toHaveBeenCalled();expect(usageCellSnapshot(agentId).mode).toBe('legacy');
    const usage = { type: 'resource-change', resource: 'agent', resourceId: agentId, usageOnly: true };
    expect(isUsageCellOnlyChange(usage)).toBe(false);installed(read, 2, true);await drain();
    expect(isUsageCellOnlyChange(usage)).toBe(true);
    expect(isUsageCellOnlyChange({ ...usage, usageOnly: false })).toBe(false);
    expect(isUsageCellOnlyChange({ type: 'resource-change', resource: 'install', usageOnly: true })).toBe(false);
  });
  it('updates the existing usage display directly from canonical cells and hides revoked numbers', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});const read = vi.fn(async () => fact(1));
    installed(read);setUsageCellProfile(agentId);await drain();
    const refresh = vi.fn(async () => ({ status: 'fresh' }));
    function Display() {const snapshot = useAgentUsageCell(agentId);return snapshot.cell?.allowed ? /*#__PURE__*/
      React.createElement(AgentUsageSection, { usage: snapshot.cell.usage ?? undefined, harness: "claude", onRefresh: refresh }) : /*#__PURE__*/React.createElement(React.Fragment, null, 'hidden');}
    let tree!: ReturnType<typeof create>;
    act(() => {tree = create(/*#__PURE__*/React.createElement(Display, null));});
    const renderedText = (node: unknown): string => {
      if (typeof node === 'string' || typeof node === 'number') return String(node);
      if (Array.isArray(node)) return node.map(renderedText).join(' ');
      return node && typeof node === 'object' && 'children' in node ? renderedText(node.children) : '';
    };
    const text = () => renderedText(tree.toJSON());
    expect(text()).toContain('14%');act(() => receiveUsageCell(fact(2, 0.52)));
    expect(text()).toContain('52%');expect(text()).not.toContain('14%');
    expect(read).toHaveBeenCalledTimes(1);expect(refresh).not.toHaveBeenCalled();
    act(() => receiveUsageCell({ ...fact(3), allowed: false, usage: undefined }));
    expect(text()).toContain('hidden');expect(text()).not.toContain('52%');act(() => tree.unmount());
  });
  it('keeps usage and revocation advancing after 1,895 distinct profiles', async () => {
    installed(async id => ({ ...fact(1), agentId: id }));
    for (let index = 0; index < 1895; index++) {
      const id = index.toString(16).padStart(64, '0');
      setUsageCellProfile(id); await drain();
      expect(usageCellSnapshot(id).cell?.agentId).toBe(id);
      receiveUsageCell({ ...fact(2), agentId: id, allowed: false, usage: undefined });
      receiveUsageCell({ ...fact(1), agentId: id });
      expect(usageCellSnapshot(id).cell?.allowed).toBe(false);
    }
  });
  it('revisiting a profile waits for current authority before painting a delayed old grant', async () => {
    let finish!: (cell: AgentUsageCell) => void; let reads = 0;
    installed(async id => {
      if (id !== agentId) return { ...fact(1), agentId: id };
      if (++reads === 1) return fact(1);
      return new Promise<AgentUsageCell>(resolve => { finish = resolve; });
    });
    setUsageCellProfile(agentId); await drain();
    receiveUsageCell({ ...fact(2), allowed: false, usage: undefined });
    setUsageCellProfile('c'.repeat(64)); await drain();
    setUsageCellProfile(agentId); await drain(); receiveUsageCell(fact(1));
    expect(usageCellSnapshot(agentId).cell).toBeNull();
    finish({ ...fact(2), allowed: false, usage: undefined }); await drain();
    expect(usageCellSnapshot(agentId).cell?.allowed).toBe(false);
  });
  it('a denial received during the baseline read never briefly paints the older allowed value', async () => {
    let finish!: (cell: AgentUsageCell) => void;
    installed(() => new Promise(resolve => { finish = resolve; })); setUsageCellProfile(agentId); await drain();
    receiveUsageCell({ ...fact(2), allowed: false, usage: undefined });
    const allowed: boolean[] = [];
    const stop = subscribeUsageCell(() => { allowed.push(usageCellSnapshot(agentId).cell?.allowed === true); });
    finish(fact(1)); await drain(); stop();
    expect(allowed).not.toContain(true); expect(usageCellSnapshot(agentId).cell?.allowed).toBe(false);
  });
});
