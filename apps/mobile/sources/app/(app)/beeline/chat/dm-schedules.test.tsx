import { readFileSync } from 'node:fs';
import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { availableSlashVerbs } from '@/buzz/slash-verbs';

const chat = readFileSync(new URL('./_chat-surface.tsx', import.meta.url), 'utf8');
// Render the production DM menu fragment: the full chat has no render harness.
const marker = chat.indexOf('testID="dm-actions-sheet"');
const start = chat.lastIndexOf('<HullActionSheetModal', marker);
const end = chat.indexOf('</HullActionSheetModal>', marker) + '</HullActionSheetModal>'.length;
const fragment = chat.slice(start, end);
const renderFragment = new Function('scope', ts.transpile(`with (scope) { return (${fragment}); }`,
  { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 }, 'menu.tsx'));
const scheduleStart = chat.indexOf('canManageSchedules: Boolean(') + 'canManageSchedules: '.length;
const scheduleEnd = chat.indexOf(',\n          canRunWorkflows:', scheduleStart);
const schedulePermission = new Function('scope', `with (scope) { return ${chat.slice(scheduleStart, scheduleEnd)}; }`);
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function scope(agent = false, member = true) {
  return {
    React, HullActionSheetModal: 'Sheet', HullActionSheetRow: 'Row', HullActionSheetCancel: 'Cancel',
    displayRoomName: 'Ruby', dmActionsVisible: true, pushMuteWorking: false, pushMuted: false,
    togglePushMute: vi.fn(), setDmActionsVisible: vi.fn(), membershipError: null,
    viewerIsAgent: agent, roomSurface: { viewer: { permissions: { send: member } } },
    decodedId: 'dm-id', activeCommunityId: 'workspace-id', router: { push: vi.fn() },
    isCorner: false, isDirectMessage: true, canManageWorkspace: false,
  };
}

describe('Reproduction 1: human DM schedules', () => {
  it('renders the menu entry for a human member without admin and opens this DM', async () => {
    const props = scope();
    let tree: any;
    await act(async () => { tree = create(renderFragment(props)); });
    const row = tree.root.findByProps({ testID: 'dm-schedules-action' });
    expect(row.props.label).toBe('Schedules and subscriptions');
    await act(async () => row.props.onPress());
    expect(props.router.push).toHaveBeenCalledWith({ pathname: '/beeline/settings/schedules',
      params: { roomId: 'dm-id', workspaceId: 'workspace-id' } });
    await act(async () => tree.unmount());
  });
  it.each([[true, true], [false, false]])('hides the entry for agent=%s member=%s', async (agent, member) => {
    let tree: any;
    await act(async () => { tree = create(renderFragment(scope(agent, member))); });
    expect(tree.root.findAllByProps({ testID: 'dm-schedules-action' })).toHaveLength(0);
    await act(async () => tree.unmount());
  });
  it('offers /schedule to the human DM member', () => {
    const canManageSchedules = schedulePermission(scope());
    expect(canManageSchedules).toBe(true);
    expect(availableSlashVerbs({ canManageSchedules } as any, 'schedule').map(v => v.command)).toContain('schedule');
    expect(schedulePermission(scope(true))).toBe(false);
    expect(schedulePermission(scope(false, false))).toBe(false);
    expect(schedulePermission({ ...scope(), isDirectMessage: false })).toBe(false);
    expect(schedulePermission({ ...scope(), isDirectMessage: false, canManageWorkspace: true })).toBe(true);
  });
});
