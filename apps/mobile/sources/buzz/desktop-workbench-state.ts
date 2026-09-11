import AsyncStorage from '@react-native-async-storage/async-storage';
import { LAYOUT_BREAKPOINTS } from '@/utils/layoutClass';

export const DESKTOP_NAV_MIN_WIDTH = 240;
export const DESKTOP_NAV_MAX_WIDTH = 360;
export const DESKTOP_NAV_DEFAULT_WIDTH = 280;
export const DESKTOP_INSPECTOR_MIN_WIDTH = 320;
export const DESKTOP_INSPECTOR_MAX_WIDTH = 480;
export const DESKTOP_INSPECTOR_DEFAULT_WIDTH = 400;

const NAV_WIDTH_KEY = 'beeline.desktop.nav-width.v1';
const INSPECTOR_WIDTH_KEY = 'beeline.desktop.inspector-width.v1';
const INSPECTOR_OPEN_KEY = 'beeline.desktop.inspector-open.v1';
const DRAFT_PREFIX = 'beeline.desktop.draft.v1:';

export type DesktopLayoutMode = 'three-pane' | 'inspector-overlay' | 'navigation-view';

export function desktopLayoutMode(width: number): DesktopLayoutMode {
  if (width >= 1180) return 'three-pane';
  if (width >= LAYOUT_BREAKPOINTS.regular) return 'inspector-overlay';
  return 'navigation-view';
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

export async function loadDesktopInspectorOpen(): Promise<boolean> {
  return (await AsyncStorage.getItem(INSPECTOR_OPEN_KEY)) === 'true';
}

export async function saveDesktopInspectorOpen(open: boolean): Promise<void> {
  await AsyncStorage.setItem(INSPECTOR_OPEN_KEY, String(open));
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

export function desktopComposerKeyAction(
  platform: string,
  key: string,
  shiftKey: boolean,
): DesktopComposerKeyAction {
  if (platform !== 'web' || key !== 'Enter') return 'none';
  return shiftKey ? 'newline' : 'send';
}
