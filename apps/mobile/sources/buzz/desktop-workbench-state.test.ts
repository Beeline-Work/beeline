import { beforeEach, describe, expect, it, vi } from 'vitest';

const values = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => values.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => values.set(key, value)),
    removeItem: vi.fn(async (key: string) => values.delete(key)),
  },
}));

import {
  clampDesktopPaneWidth,
  desktopComposerKeyAction,
  desktopDraftKey,
  desktopWorkPaneVisibleContent,
  desktopWorkPaneWidthMode,
  desktopWorkspaceRoute,
  DESKTOP_WORK_PANE_HYSTERESIS,
  DESKTOP_WORK_PANE_THRESHOLD,
  initialDesktopWorkPaneState,
  loadDesktopPaneWidth,
  saveDesktopPaneWidth,
  transitionDesktopWorkPane,
} from './desktop-workbench-state';

describe('desktop workbench state', () => {
  beforeEach(() => values.clear());

  it('derives the threshold from the three minimum readable regions', () => {
    expect(DESKTOP_WORK_PANE_THRESHOLD).toBe(240 + 440 + 320);
    expect(desktopWorkPaneWidthMode(DESKTOP_WORK_PANE_THRESHOLD)).toBe('wide');
    expect(desktopWorkPaneWidthMode(DESKTOP_WORK_PANE_THRESHOLD - 1)).toBe('narrow');
  });

  it('uses a dead band around the threshold instead of flickering', () => {
    const low = DESKTOP_WORK_PANE_THRESHOLD - DESKTOP_WORK_PANE_HYSTERESIS;
    const high = DESKTOP_WORK_PANE_THRESHOLD + DESKTOP_WORK_PANE_HYSTERESIS;
    expect(desktopWorkPaneWidthMode(low, 'wide')).toBe('wide');
    expect(desktopWorkPaneWidthMode(low - 1, 'wide')).toBe('narrow');
    expect(desktopWorkPaneWidthMode(high, 'narrow')).toBe('narrow');
    expect(desktopWorkPaneWidthMode(high + 1, 'narrow')).toBe('wide');
  });

  const WIDE = DESKTOP_WORK_PANE_THRESHOLD + 200;
  const NARROW = DESKTOP_WORK_PANE_THRESHOLD - 200;
  const artifact = {
    attachment: { id: 'a1', name: 'board.html', mimeType: 'text/html', size: 1, url: '/a1' },
  } as never;

  it('starts closed and holds nothing', () => {
    expect(initialDesktopWorkPaneState(WIDE)).toEqual({ widthMode: 'wide', content: null });
  });

  it('opens a corner of the Room in the primary view in the pane', () => {
    const opened = transitionDesktopWorkPane(initialDesktopWorkPaneState(WIDE), {
      type: 'open-corner',
      cornerId: 'c1',
      primary: 'room',
    });
    expect(opened.placement).toBe('pane');
    expect(opened.state.content).toEqual({ kind: 'corner', cornerId: 'c1' });
  });

  it('opens a corner in the primary view when a corner is already there', () => {
    const state = initialDesktopWorkPaneState(WIDE);
    const opened = transitionDesktopWorkPane(state, {
      type: 'open-corner',
      cornerId: 'c1',
      primary: 'corner',
    });
    expect(opened.placement).toBe('primary');
    expect(opened.state).toBe(state);
  });

  it('opens an artifact in the pane whether a Room or a corner is in the primary view', () => {
    for (const primary of ['room', 'corner'] as const) {
      const opened = transitionDesktopWorkPane(initialDesktopWorkPaneState(WIDE), {
        type: 'open-artifact',
        artifact,
        primary,
      });
      expect(opened.placement).toBe('pane');
      expect(opened.state.content).toEqual({ kind: 'artifact', artifact });
    }
  });

  it('holds one thing: opening something new replaces it', () => {
    let state = initialDesktopWorkPaneState(WIDE);
    state = transitionDesktopWorkPane(state, { type: 'open-artifact', artifact, primary: 'room' })
      .state;
    state = transitionDesktopWorkPane(state, {
      type: 'open-corner',
      cornerId: 'c2',
      primary: 'room',
    }).state;
    expect(state.content).toEqual({ kind: 'corner', cornerId: 'c2' });
    state = transitionDesktopWorkPane(state, { type: 'open-artifact', artifact, primary: 'room' })
      .state;
    expect(state.content).toEqual({ kind: 'artifact', artifact });
  });

  it('closes on close and on expand, and an artifact never comes back afterwards', () => {
    let state = transitionDesktopWorkPane(initialDesktopWorkPaneState(WIDE), {
      type: 'open-artifact',
      artifact,
      primary: 'room',
    }).state;
    state = transitionDesktopWorkPane(state, { type: 'close' }).state;
    expect(state.content).toBeNull();
    state = transitionDesktopWorkPane(state, {
      type: 'open-corner',
      cornerId: 'c1',
      primary: 'room',
    }).state;
    expect(state.content).toEqual({ kind: 'corner', cornerId: 'c1' });
    const expanded = transitionDesktopWorkPane(state, { type: 'expand' });
    expect(expanded.placement).toBe('primary');
    expect(expanded.state.content).toBeNull();
  });

  it('falls back to the primary view in a narrow window or a direct message', () => {
    const narrow = initialDesktopWorkPaneState(NARROW);
    expect(
      transitionDesktopWorkPane(narrow, { type: 'open-corner', cornerId: 'c1', primary: 'room' })
        .placement,
    ).toBe('primary');
    expect(
      transitionDesktopWorkPane(narrow, { type: 'open-artifact', artifact, primary: 'room' })
        .placement,
    ).toBe('primary');
    expect(
      transitionDesktopWorkPane(initialDesktopWorkPaneState(WIDE), {
        type: 'open-artifact',
        artifact,
        primary: 'direct-message',
      }).placement,
    ).toBe('primary');
  });

  it('hides its content while the window is narrow', () => {
    const open = transitionDesktopWorkPane(initialDesktopWorkPaneState(WIDE), {
      type: 'open-corner',
      cornerId: 'c1',
      primary: 'room',
    }).state;
    const narrowed = transitionDesktopWorkPane(open, { type: 'resize', width: NARROW }).state;
    expect(desktopWorkPaneVisibleContent(narrowed)).toBeNull();
    const widened = transitionDesktopWorkPane(narrowed, { type: 'resize', width: WIDE }).state;
    expect(desktopWorkPaneVisibleContent(widened)).toEqual({ kind: 'corner', cornerId: 'c1' });
  });

  it('bounds and persists both pane widths', async () => {
    expect(clampDesktopPaneWidth('navigation', 100)).toBe(240);
    expect(clampDesktopPaneWidth('inspector', 900)).toBe(480);
    await saveDesktopPaneWidth('navigation', 315.4);
    await saveDesktopPaneWidth('inspector', 438.8);
    expect(await loadDesktopPaneWidth('navigation')).toBe(315);
    expect(await loadDesktopPaneWidth('inspector')).toBe(439);
  });

  it('keeps the encoded legacy draft key for migration without legacy storage writers', () => {
    expect(desktopDraftKey('room/one')).not.toBe(desktopDraftKey('corner two'));
    expect(desktopDraftKey('room/one')).toContain('room%2Fone');
    expect(desktopDraftKey('corner two')).toContain('corner%20two');
  });

  it('sends on desktop Enter while Shift+Enter remains a newline', () => {
    expect(desktopComposerKeyAction('web', 'Enter', false)).toBe('send');
    expect(desktopComposerKeyAction('web', 'Enter', true)).toBe('newline');
    expect(desktopComposerKeyAction('ios', 'Enter', false)).toBe('none');
    expect(desktopComposerKeyAction('web', 'Escape', false)).toBe('none');
  });

  it('routes a Workspace switch to its last Room, then its first available Room', () => {
    expect(desktopWorkspaceRoute('workspace-b', ['room-b1', 'room-b2'], 'room-b2')).toEqual({
      pathname: '/beeline/chat/[channelId]',
      params: { channelId: 'room-b2', communityId: 'workspace-b' },
    });
    expect(
      desktopWorkspaceRoute('workspace-b', ['room-b1'], 'room-from-another-workspace'),
    ).toEqual({
      pathname: '/beeline/chat/[channelId]',
      params: { channelId: 'room-b1', communityId: 'workspace-b' },
    });
  });

  it('routes an empty Workspace to its addressable Room-list state', () => {
    expect(desktopWorkspaceRoute('workspace-empty', [], null)).toEqual({
      pathname: '/beeline/channels',
      params: { communityId: 'workspace-empty' },
    });
  });
});
