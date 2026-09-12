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
  desktopLayoutMode,
  loadDesktopDraft,
  loadDesktopInspectorOpen,
  loadDesktopPaneWidth,
  saveDesktopDraft,
  saveDesktopInspectorOpen,
  saveDesktopPaneWidth,
} from './desktop-workbench-state';

describe('desktop workbench state', () => {
  beforeEach(() => values.clear());

  it('keeps desktop layouts through narrow windows and overlays the inspector first', () => {
    expect(desktopLayoutMode(1280)).toBe('three-pane');
    expect(desktopLayoutMode(1180)).toBe('three-pane');
    expect(desktopLayoutMode(1179)).toBe('inspector-overlay');
    expect(desktopLayoutMode(1024)).toBe('inspector-overlay');
    expect(desktopLayoutMode(800)).toBe('inspector-overlay');
    expect(desktopLayoutMode(768)).toBe('inspector-overlay');
    expect(desktopLayoutMode(767)).toBe('navigation-view');
    expect(desktopLayoutMode(600)).toBe('navigation-view');
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

  it('persists inspector collapse state', async () => {
    expect(await loadDesktopInspectorOpen()).toBe(false);
    await saveDesktopInspectorOpen(true);
    expect(await loadDesktopInspectorOpen()).toBe(true);
  });

  it('sends on desktop Enter while Shift+Enter remains a newline', () => {
    expect(desktopComposerKeyAction('web', 'Enter', false)).toBe('send');
    expect(desktopComposerKeyAction('web', 'Enter', true)).toBe('newline');
    expect(desktopComposerKeyAction('ios', 'Enter', false)).toBe('none');
    expect(desktopComposerKeyAction('web', 'Escape', false)).toBe('none');
  });
});
