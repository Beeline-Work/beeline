import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { runBrowserProof, webProofShims } from '@/test/browserProof';

it('Demonstration draft-send-R1: browser composer retains and submits only appended text', async () => {
  const mobile = process.cwd();
  const directory = await mkdtemp(path.join(mobile, 'scripts', '.message-draft-proof-'));
  try {
    const entry = path.join(directory, 'entry.tsx');
    await writeFile(
      entry,
      `
      import React from '${mobile}/node_modules/react';
      import { createRoot } from '${mobile}/node_modules/react-dom/client';
      import { textDraftKey } from '${mobile}/sources/buzz/text-draft-store';
      globalThis.process = { env: { NODE_ENV: 'development', EXPO_OS: 'web' } };
      async function main() {
      const { DesktopRoomInspector } = await import('${mobile}/sources/components/DesktopRoomInspector');
      const person = { pubkey: 'browser-viewer', kind: 'human', name: 'Viewer' };
      const parent = { id: 'parent', workspaceId: 'workspace', name: 'Room', archived: false, createdAt: 1, updatedAt: 1 };
      const corner = { ...parent, id: 'corner', name: 'Corner' };
      const summary = { corner, state: 'working', stateAt: 1, agent: null };
      const detail = { room: corner, parent, messages: [], latestAgentTurns: [], members: [], corners: [],
        viewer: { identity: person, role: 'owner', permissions: { send: true, manage: true } }, watchFilters: [] };
      const client = { room: async () => detail, history: async () => ({ messages: [] }),
        corners: async () => ({ corners: [summary], viewer: detail.viewer, room: parent, watchFilters: [] }) };
      globalThis.sent = [];
      createRoot(document.getElementById('root')).render(<DesktopRoomInspector
        room={{ ...detail, room: parent, corners: [summary] }} client={client} selectedCornerId="corner"
        onSelectCorner={() => {}} onOpenInMain={() => {}} onClose={() => {}} onNewCorner={() => {}} />);
      const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
      const assert = (condition, message) => { if (!condition) throw Error(message); };
      const input = () => document.querySelector('textarea');
      const button = () => document.querySelector('#send');
      const type = async text => { input().value = text; input().dispatchEvent(new Event('input', { bubbles: true })); await pause(30); };
      (async () => {
        for (let i = 0; i < 100 && !input(); i++) await pause(30);
        assert(input(), 'composer did not mount');
        await type('already sent'); button().click();
        for (let i = 0; i < 100 && !globalThis.finish; i++) await pause(20);
        assert(globalThis.finish, 'send did not start');
        await type('already sent next'); await pause(550);
        globalThis.finish({}); await pause(80);
        assert(input().value === ' next', 'remaining UI: ' + input().value);
        const key = textDraftKey(person.pubkey, 'inspector-composer:corner');
        assert(localStorage.getItem(key) === JSON.stringify(' next'), 'remaining stored draft');
        button().click(); await pause(80);
        assert(JSON.stringify(globalThis.sent) === JSON.stringify(['already sent', 'next']), 'duplicate message: ' + JSON.stringify(globalThis.sent));
        assert(input().value === '' && localStorage.getItem(key) === null, 'final clear');
        document.getElementById('result').textContent = 'PASS draft-send-R1: remaining UI/storage " next"; sends ["already sent","next"]; final UI/storage empty';
      })().catch(error => { document.getElementById('result').textContent = 'FAIL ' + error.message + ' ' + globalThis.__console.join(' '); });
      }
      main().catch(error => { document.getElementById('result').textContent = 'FAIL import ' + error.message; });
    `,
    );
    const shims = {
      ...webProofShims(mobile),
      'react-native-unistyles': webProofShims(mobile)['react-native-unistyles'].replace(
        'const theme = { buzz: beelineThemes.obsidian };',
        'const theme = { buzz: beelineThemes.obsidian, colors: { groupped: { background: "#14091a" }, divider: "#333", text: "#fff", textSecondary: "#aaa", textLink: "#b08a4a", surface: "#190e21" } };',
      ),
      '@/auth/buzz-identity-storage':
        'export const loadBuzzIdentity = async () => ({ publicKey: "browser-viewer" });',
      '@/sync/transport': `export class BuzzRigTransport {
        async composeMessage({ text }) { return { id: 'message', text }; }
        async publishPreparedMessage(event) { globalThis.sent.push(event.text);
          if (globalThis.sent.length === 1) return new Promise(resolve => { globalThis.finish = resolve; }); return {}; }
      }`,
      '@/sync/transport/monolith-operation':
        'export const monolithPhoneOperation = async () => ({});',
      '@/components/buzz/ConversationComposer': `import React from 'react';
        export const COMPOSER_SINGLE_LINE_INPUT_HEIGHT = 26; export const COMPOSER_MAX_INPUT_HEIGHT = 115;
        export const ConversationComposer = props => <div><textarea value={props.value} onInput={event => props.onChangeText(event.currentTarget.value)} /><button id="send" onClick={() => props.onSend()}>Send</button></div>;`,
      'expo-router':
        'export const router = { push: () => undefined }; export const useRouter = () => router;',
      'react-native-reanimated':
        webProofShims(mobile)['react-native-reanimated'] + 'export const FadeOutDown = FadeInDown;',
      '@/modal': 'export const Modal = { alert: () => undefined, confirm: async () => false };',
      '@/components/buzz/CornerObjectiveLine': 'export const CornerBriefLink = () => null;',
      '@/components/buzz/Ledger':
        'export const LedgerRoomUpdate = () => null; export const LedgerSystemLine = () => null; export const withLedgerDayCaption = node => node;',
      '@expo/vector-icons': 'export const Ionicons = () => null;',
      '@/components/buzz/IdentityMark': 'export const IdentityMark = () => null;',
      '@/components/DesktopArtifactPane': 'export const DesktopArtifactPane = () => null;',
      '@/components/buzz/corner-brief-viewer':
        'export const openCornerBriefViewer = () => undefined;',
      '@/app/(app)/beeline/chat/RoomMessageVariants':
        'export const DaemonFactCard = () => null; export const GitHubEventCard = () => null; export const NotificationLifecycleCard = () => null; export const OrdinaryLedgerMessage = () => null;',
      '@/utils/open-external-url': 'export const openExternalUrl = async () => undefined;',
    };
    const { result, status, stderr } = await runBrowserProof({ entry, mobile, shims, width: 1100 });
    console.log(result);
    expect(status, stderr).toBe(0);
    expect(result).toMatch(/^PASS draft-send-R1:/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
