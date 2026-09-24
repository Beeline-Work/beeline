import AsyncStorage from '@react-native-async-storage/async-storage';
import { LAYOUT_BREAKPOINTS } from '@/utils/layoutClass';

export const DESKTOP_NAV_MIN_WIDTH = 240;
export const DESKTOP_NAV_MAX_WIDTH = 420;
export const DESKTOP_NAV_DEFAULT_WIDTH = 380;
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
const WORK_PANE_PREFERENCE_PREFIX = 'beeline.desktop.work-pane-preference.v1:';
const DRAFT_PREFIX = 'beeline.desktop.draft.v1:';

export type DesktopWorkPanePreference = 'present' | 'dismissed';
export type DesktopWorkPaneWidthMode = 'wide' | 'narrow';
export type DesktopWorkPaneMode = DesktopWorkPanePreference | 'suppressed';
export type DesktopWorkPaneWindowClass = 'regular-window' | 'wide-window';

export type DesktopWorkPaneState = {
  preference: DesktopWorkPanePreference;
  widthMode: DesktopWorkPaneWidthMode;
  selectedCornerId: string | null;
};

export type DesktopWorkPaneEvent =
  | { type: 'hydrate'; preference: DesktopWorkPanePreference }
  | { type: 'resize'; width: number }
  | { type: 'dismiss' }
  | { type: 'toggle' }
  | { type: 'open-overview' }
  | { type: 'open-corner'; cornerId: string }
  | { type: 'open-artifact' }
  | { type: 'drop-corner'; cornerId: string }
  | { type: 'open-corner-in-main' };

export type DesktopWorkPaneTransition = {
  state: DesktopWorkPaneState;
  placement?: 'main' | 'work';
};

export function desktopWorkPaneWindowClass(width: number): DesktopWorkPaneWindowClass {
  return width >= LAYOUT_BREAKPOINTS.wide ? 'wide-window' : 'regular-window';
}

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
  return {
    preference: 'dismissed',
    widthMode: desktopWorkPaneWidthMode(width),
    selectedCornerId: null,
  };
}

/** Live work a handle or toggle may present — archived rows do not count. */
export function desktopWorkPaneHasLiveCorners(
  corners: readonly { state: string }[] | null | undefined,
): boolean {
  return Boolean(corners?.some((corner) => corner.state !== 'archived'));
}

/**
 * A direct message has no inspector to host — no corners, no repository, no
 * roster beyond its two participants — so channel-driven pane events are
 * no-ops there: nothing can re-present the pane, and neither a dismissal nor
 * a re-presentation is ever persisted as the person's preference. Hydration
 * and window resizes still apply, so returning to a Room restores the pane
 * exactly as it was left.
 */
export function desktopWorkPaneEventApplies(
  event: DesktopWorkPaneEvent,
  isDirectMessage: boolean,
): boolean {
  if (!isDirectMessage) return true;
  return event.type === 'hydrate' || event.type === 'resize';
}

export function desktopWorkPaneMode(state: DesktopWorkPaneState): DesktopWorkPaneMode {
  return state.widthMode === 'narrow' ? 'suppressed' : state.preference;
}

export function transitionDesktopWorkPane(
  state: DesktopWorkPaneState,
  event: DesktopWorkPaneEvent,
): DesktopWorkPaneTransition {
  switch (event.type) {
    case 'hydrate':
      return { state: { ...state, preference: event.preference } };
    case 'resize':
      return {
        state: { ...state, widthMode: desktopWorkPaneWidthMode(event.width, state.widthMode) },
      };
    case 'dismiss':
      return { state: { ...state, preference: 'dismissed', selectedCornerId: null } };
    case 'toggle':
      return state.preference === 'present'
        ? { state: { ...state, preference: 'dismissed', selectedCornerId: null } }
        : { state: { ...state, preference: 'present', selectedCornerId: null } };
    case 'open-overview':
      // Handle and toggle present the corner list, never the last corner.
      return { state: { ...state, preference: 'present', selectedCornerId: null } };
    case 'drop-corner':
      return {
        state: { ...state, preference: 'present', selectedCornerId: event.cornerId },
        placement: 'work',
      };
    case 'open-corner':
      // A corner card opens the pane on that corner. A suppressed pane cannot
      // host it, so the caller falls through to the main transcript.
      if (desktopWorkPaneMode(state) === 'suppressed') return { state, placement: 'main' };
      return {
        state: { ...state, preference: 'present', selectedCornerId: event.cornerId },
        placement: 'work',
      };
    // An artifact opened from the transcript must never land silently: a
    // dismissed pane re-presents around it, a suppressed pane cannot host it
    // at all so the caller falls back, and a present pane already shows it.
    case 'open-artifact':
      if (desktopWorkPaneMode(state) === 'suppressed') return { state, placement: 'main' };
      return {
        state: state.preference === 'present' ? state : { ...state, preference: 'present' },
        placement: 'work',
      };
    case 'open-corner-in-main':
      // Maximize is a temporary zoom: the corner goes to main and the side
      // pane stays exactly as it was — including dismissed.
      return { state, placement: 'main' };
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

function desktopWorkPanePreferenceKey(windowClass: DesktopWorkPaneWindowClass): string {
  return `${WORK_PANE_PREFERENCE_PREFIX}${windowClass}`;
}

export async function loadDesktopWorkPanePreference(
  windowClass: DesktopWorkPaneWindowClass,
): Promise<DesktopWorkPanePreference> {
  return (await AsyncStorage.getItem(desktopWorkPanePreferenceKey(windowClass))) === 'present'
    ? 'present'
    : 'dismissed';
}

export async function saveDesktopWorkPanePreference(
  windowClass: DesktopWorkPaneWindowClass,
  preference: DesktopWorkPanePreference,
): Promise<void> {
  await AsyncStorage.setItem(desktopWorkPanePreferenceKey(windowClass), preference);
}

export function desktopDraftKey(roomId: string): string {
  return `${DRAFT_PREFIX}${encodeURIComponent(roomId)}`;
}

export async function loadDesktopDraft(roomId: string): Promise<string> {
  return (await AsyncStorage.getItem(desktopDraftKey(roomId))) ?? '';
}

export async function saveDesktopDraft(roomId: string, text: string): Promise<void> {
  const key = desktopDraftKey(roomId);
  if (text) await AsyncStorage.setItem(key, text);
  else await AsyncStorage.removeItem(key);
}

export type DesktopComposerKeyAction = 'send' | 'newline' | 'none';

export const DESKTOP_WORK_PANE_COMMAND = {
  id: 'toggle-work-pane',
  title: 'Toggle work pane',
  key: 'i',
  code: 'KeyI',
} as const;

export function isDesktopWorkPaneCommand(event: {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
  repeat?: boolean;
}): boolean {
  return (
    !event.isComposing &&
    !event.repeat &&
    !event.altKey &&
    !event.shiftKey &&
    (event.metaKey || event.ctrlKey) &&
    (event.code
      ? event.code === DESKTOP_WORK_PANE_COMMAND.code
      : event.key.toLowerCase() === DESKTOP_WORK_PANE_COMMAND.key)
  );
}

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
