import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_WORKSPACE_ID, WELCOME_ROOM_ID } from '@beeline/api-contract/phone';

const LANDED_PREFIX = '@beeline/welcome/landed/';

export type WelcomeLanding = { workspaceId: string; roomId: string };

export type WelcomeLandingStorage = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
};

/**
 * The first launch for an identity opens `#welcome` in the shared Beeline
 * Welcome Workspace; the claim is recorded before returning so every later
 * launch lands on the Room deck exactly as it does today.
 */
export async function claimFirstLaunchLanding(
  pubkey: string,
  storage: WelcomeLandingStorage = AsyncStorage,
): Promise<WelcomeLanding | null> {
  const key = `${LANDED_PREFIX}${pubkey}`;
  if (await storage.getItem(key)) return null;
  await storage.setItem(key, String(Date.now()));
  return { workspaceId: DEFAULT_WORKSPACE_ID, roomId: WELCOME_ROOM_ID };
}

export function welcomeRoomHref(landing: WelcomeLanding): string {
  return `/beeline/chat/${encodeURIComponent(landing.roomId)}`;
}
