import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

/**
 * Paints an agent's order and report through the ordinary ledger in both
 * themes. The same rows used to become `AgentCommandCard` records; here they
 * must carry the sender's byline, the full text, and a leading @mention.
 */
function fontsCss(mobile: string) {
  return [
    'SpaceGrotesk-Regular',
    'SpaceGrotesk-Medium',
    'SpaceGrotesk-SemiBold',
    'IBMPlexMono-Regular',
    'IBMPlexMono-SemiBold',
  ]
    .map((font) => path.join(mobile, 'sources/assets/fonts', `${font}.ttf`))
    .filter(existsSync)
    .map(
      (file) =>
        `@font-face{font-family:'${path.basename(file, '.ttf')}';src:url(data:font/ttf;base64,${readFileSync(file).toString('base64')})}`,
    )
    .join('');
}

it.skipIf(!existsSync(CHROME)).each(['bone', 'obsidian'])(
  'Reproduction agent-command-transcript-1: orders and reports render as ordinary ledger messages (%s)',
  async (theme) => {
    const mobile = process.cwd();
    const directory = await mkdtemp(path.join(mobile, 'sources/app/(app)/beeline/chat/agent-command-proof-'));
    try {
      const entry = path.join(directory, 'proof.tsx');
      await writeFile(entry, `import React from 'react';
import { createRoot } from 'react-dom/client';
import { useUnistyles } from 'react-native-unistyles';
import { readRoomViewMessage } from '@beeline/api-contract/phone';
import { displayRoomMessage } from '@/buzz/room-view-presentation';
import { agentCommandTranscriptMessage, OrdinaryLedgerMessage } from '@/app/(app)/beeline/chat/RoomMessageVariants';
import { beginReplyTarget } from '@/buzz/message-reply';
import { Button } from '@/components/buzz/Button';
import { ConversationComposer } from '@/components/buzz/ConversationComposer';

const report = {
  id: 'f'.repeat(64),
  text: '@jellybean reported to @ruby · needs-decision',
  createdAt: 1_760_000_000,
  author: { pubkey: 'a'.repeat(64), kind: 'agent', name: 'Speedy', handle: 'speedy' },
  presentation: 'card',
  agentCommand: {
    kind: 'report',
    recipient: { id: 'b'.repeat(64), name: 'Ruby', handle: 'ruby' },
    status: 'needs-decision',
    text: 'needs-decision: PR #2599 is ready for review\\nChecks are green.\\nShould I merge it now?',
  },
};
const order = {
  ...report,
  id: 'e'.repeat(64),
  text: 'ruby ordered speedy',
  author: { pubkey: 'b'.repeat(64), kind: 'agent', name: 'Ruby', handle: 'ruby' },
  agentCommand: {
    kind: 'order',
    recipient: { id: 'a'.repeat(64), name: 'Speedy', handle: 'speedy' },
    text: 'Measure main first and post the times.',
  },
};
const participants = [
  { pubkey: 'a'.repeat(64), handle: 'speedy' },
  { pubkey: 'b'.repeat(64), handle: 'ruby' },
];
const noop = () => undefined;

function Row({ row, onMention }) {
  const [replyTarget, setReplyTarget] = React.useState(null);
  const parsed = readRoomViewMessage(row);
  const message = agentCommandTranscriptMessage(
    displayRoomMessage(parsed, 'c'.repeat(64)),
    participants,
  );
  const chooseReply = () => {
    const target = beginReplyTarget(message, [], {
      messageId: message.relayId ?? message.id,
      authorName: message.authorIdentity.name,
      authorHandle: message.authorIdentity.handle,
      authorPubkey: message.pubkey,
      isAgent: true,
      preview: message.text,
    }, 'corner-id');
    if (target) setReplyTarget(target);
  };
  return <div>
    <OrdinaryLedgerMessage
      message={message}
      participantsHydrated
      viewerPubkey={'c'.repeat(64)}
      speakerWorking={false}
      continued={false}
      participantHandles={participants}
      channelIndex={{ rooms: [], corners: [] }}
      deliveryFailed={false}
      onChannelReference={noop}
      onReply={chooseReply}
      onCopy={noop}
      onRetry={noop}
      onDismiss={noop}
      onMention={onMention}
    />
    <Button label="Reply" variant="quiet" testID={'reply-' + row.id} onPress={chooseReply} />
    <ConversationComposer
      value=""
      height={40}
      focused={false}
      disabled={false}
      canSend={false}
      speechEnabled={false}
      testIDPrefix={'proof-' + row.id}
      reply={replyTarget ? { handle: replyTarget.authorHandle, preview: replyTarget.preview } : undefined}
      onCancelReply={() => setReplyTarget(null)}
      onBlur={noop}
      onChangeText={noop}
      onContentSizeChange={noop}
      onFocus={noop}
      onKeyPress={noop}
      onSend={noop}
    />
  </div>;
}

function Proof() {
  const { theme } = useUnistyles();
  document.body.style.background = theme.buzz.bgBase;
  return <main id="transcript" style={{ padding: 16, width: 360 }}>
    <Row row={report} onMention={id => window.mentioned = id} />
    <Row row={order} onMention={id => window.mentioned = id} />
  </main>;
}

async function main() {
  await Promise.all(['SpaceGrotesk-Regular', 'SpaceGrotesk-Medium', 'IBMPlexMono-Regular']
    .map(name => document.fonts.load('16px ' + name)));
  createRoot(document.getElementById('root')).render(<Proof/>);
  await new Promise(resolve => setTimeout(resolve, 200));
  const page = document.body.innerText;
  if (!page.includes('Speedy') || !page.includes('Ruby')) throw Error('byline missing: ' + page);
  if (!page.includes('Should I merge it now?')) throw Error('full report text missing: ' + page);
  if (!page.includes('Measure main first and post the times.')) throw Error('full order text missing: ' + page);
  if (page.includes('→')) throw Error('record card arrow title still painted: ' + page);
  if (document.querySelector('[data-testid^="agent-command"]')) throw Error('agent command card still painted');
  const mentions = [...document.querySelectorAll('*')].filter(node =>
    node.children.length === 0 && /^@(ruby|speedy)$/i.test(node.textContent ?? ''));
  if (mentions.length < 2) throw Error('leading mentions missing');
  const target = mentions[0].closest('[role="link"], [role="button"]');
  if (!target) throw Error('mention is not an actionable member reference');
  target.click();
  await new Promise(resolve => setTimeout(resolve, 50));
  const replyButtons = [...[report, order].map(row => document.querySelector('[data-testid="reply-' + row.id + '"]')).filter(Boolean)];
  if (replyButtons.length !== 2) throw Error('missing Reply actions');
  for (const button of replyButtons) button.click();
  await new Promise(resolve => setTimeout(resolve, 100));
  const banners = [...document.querySelectorAll('[data-testid="reply-composer-banner"]')]
    .map(node => node.textContent);
  if (banners.length !== 2) throw Error('missing composer reply targets: ' + banners.length);
  if (!banners[0].includes('@speedy')) throw Error('report reply target: ' + banners[0]);
  if (!banners[1].includes('@ruby')) throw Error('order reply target: ' + banners[1]);
  document.getElementById('result').textContent = JSON.stringify({
    theme: document.body.style.background,
    accent: useUnistyles().theme.buzz.accent,
    mentions: mentions.map(node => getComputedStyle(node).color),
    mentioned: window.mentioned,
    replyTargets: banners,
    rows: document.querySelectorAll('#transcript > div').length,
    card: document.querySelectorAll('[data-testid^="agent-command"]').length,
  });
}
main().catch(error => document.getElementById('result').textContent = 'FAIL: ' + error.message);`);
      const base = webProofShims(mobile);
      const shims: Record<string, string> = {
        ...base,
        'react-native-unistyles': base['react-native-unistyles']!.replace(
          'beelineThemes.obsidian',
          `beelineThemes.${theme}`,
        ),
        'react-native-reanimated': `${base['react-native-reanimated']}
        const builder = new Proxy({}, { get: () => () => builder });
        export const FadeOut = builder; export const FadeIn = builder; export const Layout = builder;
        export const FadeOutDown = builder; export const FadeInUp = builder; export const FadeOutUp = builder;
        export const LinearTransition = builder;
        export const interpolateColor = (_value, _input, output) => output[output.length - 1];`,
        'react-native-gesture-handler': `import React from 'react';
        export const Swipeable = props => React.createElement('div', props, props.children);
        export const GestureHandlerRootView = props => React.createElement('div', props, props.children);`,
        'expo-router': `export const useLocalSearchParams = () => ({});
        export const router = { push() {}, back() {}, replace() {} };
        export const useRouter = () => router; export const usePathname = () => '/';`,
        '@/modal': 'export const Modal = { alert: () => undefined, confirm: async () => false };',
        '@/modal/ModalManager':
          'export const Modal = { alert: () => undefined, confirm: async () => false };',
        '@/sync/storage': `const state = { settings: {}, localSettings: {} };
        export const storage = Object.assign((select) => select(state), { getState: () => state, subscribe: () => () => undefined });`,
        '@/sync/persistence': `export const loadLocalSettings = () => ({}); export const saveLocalSettings = () => {};
        export const loadSettings = () => ({ settings: {}, version: null });`,
        'react-native-view-shot': `export const captureRef = async () => ''; export default {};`,
        '@expo/vector-icons': `import React from 'react';
        export const Ionicons = (props) => React.createElement('span', { 'data-icon': props.name });`,
      };
      const proof = await runBrowserProof({
        entry,
        mobile,
        width: 400,
        height: 340,
        head: `<style>${fontsCss(mobile)}</style><script>window.process={env:{NODE_ENV:'development'}};</script>`,
        shims,
      });
      expect(proof.status, proof.stderr).toBe(0);
      expect(proof.result).not.toMatch(/^FAIL/);
      const result = JSON.parse(proof.result);
      expect(result.rows).toBe(2);
      expect(result.card).toBe(0);
      expect(result.mentions).toHaveLength(2);
      expect(result.mentioned).toBe('b'.repeat(64));
      expect(result.replyTargets).toHaveLength(2);
      expect(result.replyTargets[0]).toContain('@speedy');
      expect(result.replyTargets[1]).toContain('@ruby');
      expect(result.theme).not.toBe('');
      const rgb = (hex: string) => {
        const value = hex.replace('#', '');
        return `rgb(${parseInt(value.slice(0, 2), 16)}, ${parseInt(value.slice(2, 4), 16)}, ${parseInt(value.slice(4, 6), 16)})`;
      };
      for (const color of result.mentions) expect(color).toBe(rgb(result.accent));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  90_000,
);
