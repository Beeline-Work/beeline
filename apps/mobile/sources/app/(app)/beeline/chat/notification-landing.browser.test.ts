import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

const ROOM = '0b9c3a52-6f1e-4c55-9d2a-3e8f7a6b1c20';
const VIEWER = 'a'.repeat(64);
const ANN = { pubkey: 'b'.repeat(64), kind: 'human', name: 'Ann' };
const id = (prefix: string, n: number) => prefix + String(n).padStart(63, '0');
const TARGET = id('e', 0);
const BASE = 1_790_000_000;

function row(messageId: string, text: string, createdAt: number) {
  return {
    id: messageId,
    text,
    createdAt,
    author: ANN,
    presentation: 'message',
    reference: { channelId: ROOM, eventId: messageId, rootId: messageId },
  };
}

/** The Room's tail: 30 messages, all newer than the notification's target. */
const tail = Array.from({ length: 30 }, (_, n) =>
  row(id('c', n), `Tail message ${n}`, BASE + 10_000 + n * 60),
);
/** The page around the target: 15 older rows, the target, 14 newer rows — all older than the tail. */
const aroundPage = {
  roomId: ROOM,
  messages: [
    ...Array.from({ length: 15 }, (_, n) => row(id('d', n), `Around message ${n}`, BASE + n * 60)),
    row(TARGET, 'TARGET MESSAGE', BASE + 15 * 60),
    ...Array.from({ length: 14 }, (_, n) =>
      row(id('d', 15 + n), `Around message ${15 + n}`, BASE + (16 + n) * 60),
    ),
  ],
  nextBefore: { createdAt: BASE, id: id('d', 0) },
};

const roomView = {
  room: {
    id: ROOM,
    workspaceId: 'workspace',
    name: 'Launch room',
    archived: false,
    createdAt: 1,
    updatedAt: 2,
  },
  messages: tail,
  members: [
    { identity: { pubkey: VIEWER, kind: 'human', name: 'Viewer' }, role: 'owner' },
    { identity: ANN, role: 'member' },
  ],
  latestAgentTurns: [],
  viewer: {
    identity: { pubkey: VIEWER, kind: 'human', name: 'Viewer' },
    role: 'owner',
    permissions: { send: true, manage: true },
  },
  repositoryResolution: { status: 'absent' },
  watchFilters: [{ '#h': [ROOM] }],
};

function shims(mobile: string): Record<string, string> {
  const base = webProofShims(mobile);
  return {
    ...base,
    'react-native-unistyles': `import { beelineThemes } from '${path.join(mobile, 'sources/buzz/groknight')}';
    import * as legacy from '${path.join(mobile, 'sources/theme')}';
    const theme = { ...(legacy.obsidianTheme ?? {}), buzz: beelineThemes.obsidian, dark: beelineThemes.obsidian.dark };
    export const StyleSheet = { create: f => (typeof f === 'function' ? f(theme) : f), hairlineWidth: 1,
      absoluteFillObject: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } };
    export const useUnistyles = () => ({ theme });
    export const UnistylesRuntime = { setTheme() {}, setRootViewBackgroundColor() {} };`,
    'react-native-reanimated': `${base['react-native-reanimated']}
    const builder = new Proxy({}, { get: () => () => builder });
    export const FadeOut = builder; export const FadeIn = builder; export const Layout = builder;
    export const FadeOutDown = builder; export const FadeInUp = builder; export const FadeOutUp = builder;
    export const LinearTransition = builder; export const withSpring = identity;
    export const interpolateColor = (v, i, o) => o[o.length - 1];`,
    'react-native-keyboard-controller': `export { KeyboardAvoidingView, ScrollView as KeyboardAwareScrollView } from 'react-native';
    export const KeyboardProvider = ({ children }) => children;
    export const useKeyboardState = (select) => (select ? select({ height: 0, isVisible: false }) : { height: 0, isVisible: false });
    export const useReanimatedKeyboardAnimation = () => ({ height: { value: 0 }, progress: { value: 0 } });`,
    // Dictation is native-only; the web build has no recognizer.
    'expo-speech-recognition': 'export const ExpoSpeechRecognitionModule = null;',
    'react-native-view-shot': `export const captureRef = async () => ''; export default {};`,
    '@expo/vector-icons': `import React from 'react';
    export const Ionicons = (props) => React.createElement('span', { 'data-icon': props.name });`,
    // The notification tap: the Room route opened with the response and the message it names.
    'expo-router': `import React from 'react';
    export const useFocusEffect = (effect) => React.useEffect(effect, [effect]);
    export const useLocalSearchParams = () => ({ channelId: '${ROOM}', notificationResponseId: 'push-1', notificationMessageId: '${TARGET}' });
    export const useRouter = () => router;
    export const router = { push() {}, back() {}, replace() {}, navigate() {}, setParams() {}, canGoBack: () => false };
    export const usePathname = () => '/beeline/chat/${ROOM}';
    export const useSegments = () => [];
    export const useNavigation = () => ({ setOptions() {}, addListener: () => () => undefined, goBack() {}, canGoBack: () => false, getParent: () => undefined, navigate() {}, dispatch() {} });`,
    '@react-navigation/native': `import React from 'react';
    export const useIsFocused = () => true;
    export const useNavigation = () => ({ setOptions() {}, addListener: () => () => undefined, goBack() {}, canGoBack: () => false, getParent: () => undefined, navigate() {}, dispatch() {} });
    export const useFocusEffect = (effect) => React.useEffect(effect, [effect]);`,
    '@react-native-async-storage/async-storage': `const store = new Map();
    export default { getItem: async (k) => store.get(k) ?? null, setItem: async (k, v) => { store.set(k, v); }, removeItem: async (k) => { store.delete(k); },
      multiGet: async (keys) => keys.map((k) => [k, store.get(k) ?? null]), multiSet: async () => undefined, getAllKeys: async () => [...store.keys()] };`,
    '@/auth/buzz-identity-storage': `export const getEffectiveRelayUrl = async () => 'https://relay.test';
    export const loadBuzzViewerPubkey = async () => '${VIEWER}';
    export const loadBuzzIdentity = async () => ({ publicKey: '${VIEWER}', secretKey: new Uint8Array(32) });`,
    '@/buzz/surface-storage': `export const mobileSurfaceCache = { read: async () => null, write: async () => undefined, remove: async () => undefined };
    export const surfaceAddress = (_relay, _viewer, path) => path;
    export const createRoomOutbox = () => ({ restore: async () => undefined, list: () => [], reconcile: async () => undefined,
      fail: async () => undefined, retry: async () => undefined, remove: async () => undefined, attempted: async () => undefined,
      get: () => undefined, add: async () => undefined });`,
    '@/buzz/community-storage': `export const saveActiveCommunityId = async () => undefined; export const saveLastViewedChannel = async () => undefined;`,
    '@/sync/transport': `export class BuzzRigTransport {
      async ensureClient() { return { surfaceSubscribe: async (_filters, emit) => { setTimeout(() => emit({ monolithLive: { type: 'subscribed', roomId: '${ROOM}' } }), 0); return () => undefined; } }; }
      async publishPreparedMessage() {}
      reconnectLive() {}
      async reopenChat() {}
    }`,
    // The network boundary. historyAround parks its promise on globalThis.__around for the entry to settle.
    '@/sync/transport/room-view-client': `import { RoomViewHttpError } from '@beeline/buzz-client';
    export { RoomViewHttpError };
    const view = ${JSON.stringify(roomView)};
    globalThis.__around = { calls: 0, pending: [], page: ${JSON.stringify(aroundPage)},
      makeMissing: () => new RoomViewHttpError(404, 'not_found') };
    export const isRoomViewTimeoutError = () => false;
    export const readPushedMonolithRoom = async () => view;
    class Client {
      async room() { return view; }
      async markRead() {}
      async markUnread() {}
      async history(roomId) { return { roomId, messages: [] }; }
      async historyAfter(roomId) { return { roomId, messages: [] }; }
      historyAround() {
        globalThis.__around.calls += 1;
        return new Promise((resolve, reject) => globalThis.__around.pending.push({ resolve, reject }));
      }
    }
    // Any other read the Room screen makes stays unanswered rather than inventing data.
    export class RoomViewClient extends Client {
      constructor() {
        super();
        return new Proxy(this, { get: (t, k) => (k in t ? t[k] : (typeof k === 'string' ? () => new Promise(() => undefined) : undefined)) });
      }
    }`,
  };
}

type Observation = {
  locating: boolean;
  noLongerAvailable: boolean;
  rows: string[];
  composer: boolean;
  target: { present: boolean; flashed: boolean; flashColor: string | null; top: number | null };
  historyAroundCalls: number;
  listHeight: number;
};
type Proof = {
  mode: string;
  pending: Observation & { shown: boolean };
  typing: { present: boolean; typed: string | null };
  settled?: Observation;
  console: string[];
};

async function proof(mode: 'stall' | 'answer' | 'missing'): Promise<Proof> {
  const mobile = process.cwd();
  const { result, status, stderr } = await runBrowserProof({
    entry: path.join(mobile, 'scripts/notification-landing-proof.tsx'),
    mobile,
    shims: shims(mobile),
    width: 390,
    height: 844,
    query: `?mode=${mode}`,
    budgetMs: 15_000,
  });
  expect(status, stderr).toBe(0);
  if (process.env.PRINT_PROOF) console.log(result);
  expect(result.startsWith('{'), result).toBe(true);
  return JSON.parse(result) as Proof;
}

const tailRow = /^Tail message \d+$/;

describe.skipIf(!existsSync(CHROME))(
  'Notification landing on the real Room route at 390x844',
  () => {
    it('keeps the room usable while the read around the target is pending', async () => {
      const page = await proof('stall');
      const { pending } = page;
      console.log(
        `stalled read: historyAround calls=${pending.historyAroundCalls}; "Locating message" shown=${pending.locating}; ` +
          `visible rows=${pending.rows.length} (${pending.rows[0]} … ${pending.rows.at(-1)}); ` +
          `composer present=${page.typing.present}, typed value=${JSON.stringify(page.typing.typed)}`,
      );
      expect(pending.historyAroundCalls).toBe(1);
      expect(pending.locating).toBe(false);
      expect(pending.rows.length).toBeGreaterThan(0);
      expect(pending.rows.every((text) => tailRow.test(text))).toBe(true);
      expect(pending.rows).toContain('Tail message 29');
      expect(page.typing).toEqual({ present: true, typed: 'still typing' });
    }, 120_000);

    it('lands the answered target near the top of the list, flashed', async () => {
      const page = await proof('answer');
      const settled = page.settled!;
      console.log(
        `answered read: historyAround calls=${settled.historyAroundCalls}; before answer rows=${page.pending.rows.length} tail, locating=${page.pending.locating}; ` +
          `after answer target present=${settled.target.present}, flashed=${settled.target.flashed} (${settled.target.flashColor}), ` +
          `top offset in list=${settled.target.top}px of ${settled.listHeight}px; visible rows=${JSON.stringify(settled.rows.slice(0, 3))}…; locating=${settled.locating}`,
      );
      expect(page.pending.locating).toBe(false);
      expect(page.pending.rows.length).toBeGreaterThan(0);
      expect(settled.locating).toBe(false);
      expect(settled.target.present).toBe(true);
      expect(settled.target.flashed).toBe(true);
      expect(settled.target.top).not.toBeNull();
      expect(settled.target.top!).toBeGreaterThanOrEqual(-10);
      expect(settled.target.top!).toBeLessThan(120);
      expect(settled.rows).toContain('TARGET MESSAGE');
    }, 120_000);

    it('shows a short note and keeps the tail when the target is gone (404)', async () => {
      const page = await proof('missing');
      const settled = page.settled!;
      console.log(
        `404 read: historyAround calls=${settled.historyAroundCalls}; "That message is no longer available" shown=${settled.noLongerAvailable}; ` +
          `locating=${settled.locating}; visible rows=${settled.rows.length} (${settled.rows[0]} … ${settled.rows.at(-1)}); composer present=${settled.composer}`,
      );
      expect(settled.noLongerAvailable).toBe(true);
      expect(settled.locating).toBe(false);
      expect(settled.rows.length).toBeGreaterThan(0);
      expect(settled.rows.every((text) => tailRow.test(text))).toBe(true);
      expect(settled.rows).toContain('Tail message 29');
      expect(settled.composer).toBe(true);
    }, 120_000);
  },
);
