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
  desktopWorkPaneEventApplies,
  desktopWorkPaneMode,
  desktopWorkPaneWidthMode,
  desktopWorkPaneWindowClass,
  desktopWorkspaceRoute,
  DESKTOP_WORK_PANE_HYSTERESIS,
  DESKTOP_WORK_PANE_COMMAND,
  DESKTOP_WORK_PANE_THRESHOLD,
  initialDesktopWorkPaneState,
  isDesktopWorkPaneCommand,
  type DesktopWorkPaneEvent,
  loadDesktopDraft,
  loadDesktopWorkPanePreference,
  loadDesktopPaneWidth,
  saveDesktopDraft,
  saveDesktopWorkPanePreference,
  saveDesktopPaneWidth,
  transitionDesktopWorkPane,
} from './desktop-workbench-state';

describe('desktop workbench state', () => {
  beforeEach(() => values.clear());

  it('a direct message lets through only hydration and window resizes', () => {
    const events: DesktopWorkPaneEvent[] = [
      { type: 'hydrate', preference: 'present' },
      { type: 'resize', width: 1400 },
      { type: 'dismiss' },
      { type: 'toggle' },
      { type: 'open-overview' },
      { type: 'open-corner', cornerId: 'c1' },
      { type: 'open-artifact' },
      { type: 'drop-corner', cornerId: 'c1' },
      { type: 'open-corner-in-main' },
    ];
    for (const event of events) {
      expect(desktopWorkPaneEventApplies(event, true)).toBe(
        event.type === 'hydrate' || event.type === 'resize',
      );
      expect(desktopWorkPaneEventApplies(event, false)).toBe(true);
    }
  });

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

  it('opens every corner in work while present and in main while dismissed or suppressed', () => {
    const wide = initialDesktopWorkPaneState(DESKTOP_WORK_PANE_THRESHOLD + 100);
    const inWork = transitionDesktopWorkPane(wide, { type: 'open-corner', cornerId: 'c1' });
    expect(inWork).toMatchObject({ placement: 'work', state: { selectedCornerId: 'c1' } });
    const dismissed = transitionDesktopWorkPane(inWork.state, { type: 'dismiss' }).state;
    expect(desktopWorkPaneMode(dismissed)).toBe('dismissed');
    expect(transitionDesktopWorkPane(dismissed, { type: 'open-corner', cornerId: 'c2' })).toEqual({
      state: dismissed,
      placement: 'main',
    });
    const suppressed = transitionDesktopWorkPane(wide, {
      type: 'resize',
      width: DESKTOP_WORK_PANE_THRESHOLD - DESKTOP_WORK_PANE_HYSTERESIS - 1,
    }).state;
    expect(desktopWorkPaneMode(suppressed)).toBe('suppressed');
    expect(
      transitionDesktopWorkPane(suppressed, { type: 'open-corner', cornerId: 'c3' }).placement,
    ).toBe('main');
  });

  it('re-presents the pane around an artifact and hands a suppressed pane to the caller', () => {
    const wide = initialDesktopWorkPaneState(DESKTOP_WORK_PANE_THRESHOLD + 100);
    expect(transitionDesktopWorkPane(wide, { type: 'open-artifact' })).toEqual({
      state: wide,
      placement: 'work',
    });
    const dismissed = transitionDesktopWorkPane(wide, { type: 'dismiss' }).state;
    const rePresented = transitionDesktopWorkPane(dismissed, { type: 'open-artifact' });
    expect(rePresented).toMatchObject({ placement: 'work', state: { preference: 'present' } });
    expect(desktopWorkPaneMode(rePresented.state)).toBe('present');
    const suppressed = transitionDesktopWorkPane(wide, {
      type: 'resize',
      width: DESKTOP_WORK_PANE_THRESHOLD - DESKTOP_WORK_PANE_HYSTERESIS - 1,
    }).state;
    expect(transitionDesktopWorkPane(suppressed, { type: 'open-artifact' })).toEqual({
      state: suppressed,
      placement: 'main',
    });
  });

  it('keeps responsive suppression separate from present and dismissed memory', () => {
    const wide = initialDesktopWorkPaneState(DESKTOP_WORK_PANE_THRESHOLD + 100);
    const narrowWidth = DESKTOP_WORK_PANE_THRESHOLD - DESKTOP_WORK_PANE_HYSTERESIS - 1;
    const wideWidth = DESKTOP_WORK_PANE_THRESHOLD + DESKTOP_WORK_PANE_HYSTERESIS + 1;
    const suppressedPresent = transitionDesktopWorkPane(wide, {
      type: 'resize',
      width: narrowWidth,
    }).state;
    expect(desktopWorkPaneMode(suppressedPresent)).toBe('suppressed');
    expect(
      desktopWorkPaneMode(
        transitionDesktopWorkPane(suppressedPresent, { type: 'resize', width: wideWidth }).state,
      ),
    ).toBe('present');
    const dismissed = transitionDesktopWorkPane(wide, { type: 'dismiss' }).state;
    const suppressedDismissed = transitionDesktopWorkPane(dismissed, {
      type: 'resize',
      width: narrowWidth,
    }).state;
    expect(
      desktopWorkPaneMode(
        transitionDesktopWorkPane(suppressedDismissed, { type: 'resize', width: wideWidth }).state,
      ),
    ).toBe('dismissed');
  });

  it('restores overview from the handle, restores a dropped corner, and promotes to main', () => {
    const dismissed = transitionDesktopWorkPane(
      initialDesktopWorkPaneState(DESKTOP_WORK_PANE_THRESHOLD + 100),
      { type: 'dismiss' },
    ).state;
    expect(transitionDesktopWorkPane(dismissed, { type: 'open-overview' }).state).toMatchObject({
      preference: 'present',
      selectedCornerId: null,
    });
    const dropped = transitionDesktopWorkPane(dismissed, {
      type: 'drop-corner',
      cornerId: 'c1',
    });
    expect(dropped).toMatchObject({
      placement: 'work',
      state: { preference: 'present', selectedCornerId: 'c1' },
    });
    expect(transitionDesktopWorkPane(dropped.state, { type: 'open-corner-in-main' })).toMatchObject(
      {
        placement: 'main',
        state: { preference: 'present', selectedCornerId: null },
      },
    );
  });

  it('toggles the remembered preference even while responsive suppression is active', () => {
    const narrow = initialDesktopWorkPaneState(DESKTOP_WORK_PANE_THRESHOLD - 100);
    const dismissed = transitionDesktopWorkPane(narrow, { type: 'toggle' }).state;
    expect(desktopWorkPaneMode(dismissed)).toBe('suppressed');
    expect(dismissed.preference).toBe('dismissed');
  });

  it('defines one keyboard command with the same toggle semantics', () => {
    expect(DESKTOP_WORK_PANE_COMMAND.title).toBe('Toggle work pane');
    expect(
      isDesktopWorkPaneCommand({
        key: 'i',
        code: 'KeyI',
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toBe(true);
    expect(
      isDesktopWorkPaneCommand({
        key: 'i',
        code: 'KeyI',
        metaKey: false,
        ctrlKey: true,
        altKey: false,
        shiftKey: false,
      }),
    ).toBe(true);
    expect(
      isDesktopWorkPaneCommand({
        key: 'i',
        code: 'KeyI',
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: true,
      }),
    ).toBe(false);
  });

  it('bounds and persists both pane widths', async () => {
    expect(clampDesktopPaneWidth('navigation', 100)).toBe(240);
    expect(clampDesktopPaneWidth('inspector', 900)).toBe(480);
    await saveDesktopPaneWidth('navigation', 315.4);
    await saveDesktopPaneWidth('inspector', 438.8);
    expect(await loadDesktopPaneWidth('navigation')).toBe(315);
    expect(await loadDesktopPaneWidth('inspector')).toBe(439);
  });

  it('stores drafts independently by encoded Room or Corner id and removes empty drafts', async () => {
    await saveDesktopDraft('room/one', 'Room draft');
    await saveDesktopDraft('corner two', 'Corner draft');
    expect(desktopDraftKey('room/one')).not.toBe(desktopDraftKey('corner two'));
    expect(await loadDesktopDraft('room/one')).toBe('Room draft');
    expect(await loadDesktopDraft('corner two')).toBe('Corner draft');
    await saveDesktopDraft('room/one', '');
    expect(await loadDesktopDraft('room/one')).toBe('');
  });

  it('persists pane preference independently for regular and wide device windows', async () => {
    expect(desktopWorkPaneWindowClass(1100)).toBe('regular-window');
    expect(desktopWorkPaneWindowClass(1400)).toBe('wide-window');
    expect(await loadDesktopWorkPanePreference('regular-window')).toBe('present');
    await saveDesktopWorkPanePreference('regular-window', 'dismissed');
    expect(await loadDesktopWorkPanePreference('regular-window')).toBe('dismissed');
    expect(await loadDesktopWorkPanePreference('wide-window')).toBe('present');
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
