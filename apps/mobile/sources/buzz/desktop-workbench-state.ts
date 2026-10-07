import AsyncStorage from '@react-native-async-storage/async-storage';
import type { DesktopArtifactSelection } from '@/buzz/desktop-artifact-pane';

export const DESKTOP_NAV_MIN_WIDTH = 240;
export const DESKTOP_NAV_MAX_WIDTH = 420;
export const DESKTOP_NAV_DEFAULT_WIDTH = 260;
export const DESKTOP_WORKSPACE_STRIP_WIDTH = 76;
export const DESKTOP_INSPECTOR_MIN_WIDTH = 320;
export const DESKTOP_INSPECTOR_MAX_WIDTH = 480;
export const DESKTOP_INSPECTOR_DEFAULT_WIDTH = 400;
/** Smallest useful middle transcript once the permanent Room list is present. */
export const DESKTOP_TRANSCRIPT_MIN_WIDTH = 440;
/** The honest point at which all three readable regions fit side by side. */
export const DESKTOP_WORK_PANE_THRESHOLD =
  DESKTOP_NAV_MIN_WIDTH + DESKTOP_TRANSCRIPT_MIN_WIDTH + DESKTOP_INSPECTOR_MIN_WIDTH;
export const DESKTOP_WORK_PANE_HYSTERESIS = 24;

const NAV_WIDTH_KEY = 'beeline.desktop.nav-width.v1';
const INSPECTOR_WIDTH_KEY = 'beeline.desktop.inspector-width.v1';
const DRAFT_PREFIX = 'beeline.desktop.draft.v1:';

export type DesktopWorkPaneWidthMode = 'wide' | 'narrow';

/** The second pane holds one thing at a time, or nothing. */
export type DesktopWorkPaneContent =
  | { kind: 'corner'; cornerId: string }
  | { kind: 'artifact'; artifact: DesktopArtifactSelection };

export type DesktopWorkPaneState = {
  widthMode: DesktopWorkPaneWidthMode;
  content: DesktopWorkPaneContent | null;
};

export type DesktopWorkPanePrimary = 'room' | 'corner' | 'direct-message';

export type DesktopWorkPaneEvent =
  | { type: 'resize'; width: number }
  | { type: 'close' }
  | { type: 'open-corner'; cornerId: string; primary: DesktopWorkPanePrimary }
  | { type: 'open-artifact'; artifact: DesktopArtifactSelection; primary: DesktopWorkPanePrimary }
  | { type: 'expand' };

/**
 * `pane`: the second pane now shows it. `primary`: the caller opens a corner
 * in the primary view, or an artifact in the full-screen viewer.
 */
export type DesktopWorkPaneTransition = {
  state: DesktopWorkPaneState;
  placement?: 'pane' | 'primary';
};

export function desktopWorkPaneWidthMode(
  width: number,
  previous?: DesktopWorkPaneWidthMode,
): DesktopWorkPaneWidthMode {
  if (previous === 'wide')
    return width < DESKTOP_WORK_PANE_THRESHOLD - DESKTOP_WORK_PANE_HYSTERESIS ? 'narrow' : 'wide';
  if (previous === 'narrow')
    return width > DESKTOP_WORK_PANE_THRESHOLD + DESKTOP_WORK_PANE_HYSTERESIS ? 'wide' : 'narrow';
  return width >= DESKTOP_WORK_PANE_THRESHOLD ? 'wide' : 'narrow';
}

export function initialDesktopWorkPaneState(width: number): DesktopWorkPaneState {
  return { widthMode: desktopWorkPaneWidthMode(width), content: null };
}

/** What the second pane shows right now; a narrow window shows nothing. */
export function desktopWorkPaneVisibleContent(
  state: DesktopWorkPaneState,
): DesktopWorkPaneContent | null {
  return state.widthMode === 'narrow' ? null : state.content;
}

/**
 * The pane opens only for an artifact clicked in a Room or a corner. Opening
 * one replaces what was there. A narrow window or a direct message cannot
 * host it, so the caller falls back to the full-screen viewer. A corner
 * always opens in the primary view, never in the pane.
 */
export function transitionDesktopWorkPane(
  state: DesktopWorkPaneState,
  event: DesktopWorkPaneEvent,
): DesktopWorkPaneTransition {
  switch (event.type) {
    case 'resize':
      return {
        state: { ...state, widthMode: desktopWorkPaneWidthMode(event.width, state.widthMode) },
      };
    case 'close':
      return { state: { ...state, content: null } };
    case 'open-corner':
      return { state, placement: 'primary' };
    case 'open-artifact':
      if (state.widthMode === 'narrow' || event.primary === 'direct-message')
        return { state, placement: 'primary' };
      return {
        state: { ...state, content: { kind: 'artifact', artifact: event.artifact } },
        placement: 'pane',
      };
    case 'expand':
      // The corner moves to the primary view, so the pane closes and nothing
      // shows twice.
      return { state: { ...state, content: null }, placement: 'primary' };
  }
}

export function clampDesktopPaneWidth(kind: 'navigation' | 'inspector', width: number): number {
  const [minimum, maximum] =
    kind === 'navigation'
      ? [DESKTOP_NAV_MIN_WIDTH, DESKTOP_NAV_MAX_WIDTH]
      : [DESKTOP_INSPECTOR_MIN_WIDTH, DESKTOP_INSPECTOR_MAX_WIDTH];
  return Math.round(Math.min(maximum, Math.max(minimum, width)));
}

function storedNumber(raw: string | null, fallback: number, kind: 'navigation' | 'inspector') {
  const parsed = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) ? clampDesktopPaneWidth(kind, parsed) : fallback;
}

export async function loadDesktopPaneWidth(kind: 'navigation' | 'inspector'): Promise<number> {
  const key = kind === 'navigation' ? NAV_WIDTH_KEY : INSPECTOR_WIDTH_KEY;
  const fallback =
    kind === 'navigation' ? DESKTOP_NAV_DEFAULT_WIDTH : DESKTOP_INSPECTOR_DEFAULT_WIDTH;
  return storedNumber(await AsyncStorage.getItem(key), fallback, kind);
}

export async function saveDesktopPaneWidth(
  kind: 'navigation' | 'inspector',
  width: number,
): Promise<void> {
  const key = kind === 'navigation' ? NAV_WIDTH_KEY : INSPECTOR_WIDTH_KEY;
  await AsyncStorage.setItem(key, String(clampDesktopPaneWidth(kind, width)));
}

export function desktopDraftKey(roomId: string): string {
  return `${DRAFT_PREFIX}${encodeURIComponent(roomId)}`;
}

export type DesktopComposerKeyAction = 'send' | 'newline' | 'none';

export type DesktopWorkspaceRoute =
  | {
      pathname: '/beeline/chat/[channelId]';
      params: { channelId: string; communityId: string };
    }
  | {
      pathname: '/beeline/channels';
      params: { communityId: string };
    };

/** Keep a desktop Workspace switch URL-addressable, including when it has no Rooms. */
export function desktopWorkspaceRoute(
  workspaceId: string,
  roomIds: readonly string[],
  lastViewedRoomId: string | null,
): DesktopWorkspaceRoute {
  const roomId =
    (lastViewedRoomId && roomIds.includes(lastViewedRoomId) ? lastViewedRoomId : null) ??
    roomIds[0] ??
    null;
  return roomId
    ? {
        pathname: '/beeline/chat/[channelId]',
        params: { channelId: roomId, communityId: workspaceId },
      }
    : { pathname: '/beeline/channels', params: { communityId: workspaceId } };
}

export function desktopComposerKeyAction(
  platform: string,
  key: string,
  shiftKey: boolean,
): DesktopComposerKeyAction {
  if (platform !== 'web' || key !== 'Enter') return 'none';
  return shiftKey ? 'newline' : 'send';
}
