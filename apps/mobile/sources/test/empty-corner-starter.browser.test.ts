import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { runBrowserProof, webProofShims } from './browserProof';

// Execute the production surface's hooks and empty-state JSX together. Network,
// navigation and the rest of the chat screen are outside this focused proof.
it('empty corner surface fills its first agent mention, focuses, and preserves drafts on phone and desktop', async () => {
  const mobile = process.cwd();
  const source = await readFile(path.join(mobile, 'sources/app/(app)/beeline/chat/_chat-surface.tsx'), 'utf8');
  const slice = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  const hooks = slice('  const firstRoomAgent = useMemo(', '  // The same minted pairing command');
  const empty = slice('  const showEmptyLedger =', '  // Landing retries can outlive');
  expect(source).toContain('ListEmptyComponent={emptyLedger}');
  expect(source).toContain('{transcriptMessages.length > 0 && emptyLedger}');
  expect(source).toContain('{emptyLedger}\n                    {transcriptMessages.length > 0');
  const directory = await mkdtemp(path.join(mobile, 'sources/test/empty-corner-'));
  try {
    const entry = path.join(directory, 'proof.tsx');
    await writeFile(entry, `import React, { useMemo, useCallback, useRef, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { View, TextInput } from 'react-native';
      import { EmptyLedgerState, cornerNeedsStarter } from '@/components/buzz/EmptyLedgerState';
      import { planComposerFill } from '@/buzz/composer-fill';
      import { beelineThemes } from '@/buzz/groknight';
      import regularFont from '@/assets/fonts/SpaceGrotesk-Regular.ttf';
      import strongFont from '@/assets/fonts/SpaceGrotesk-SemiBold.ttf';
      import monoFont from '@/assets/fonts/IBMPlexMono-SemiBold.ttf';
      const theme = beelineThemes.obsidian;
      const fontStyle = document.createElement('style');
      fontStyle.textContent = '@font-face{font-family:SpaceGrotesk-Regular;src:url(' + regularFont + ')}'
        + '@font-face{font-family:SpaceGrotesk-SemiBold;src:url(' + strongFont + ')}'
        + '@font-face{font-family:IBMPlexMono-SemiBold;src:url(' + monoFont + ')}'
        + 'html,body{background:' + theme.bgBase + '}#result{display:none}';
      document.head.appendChild(fontStyle);
      const scheduleAnimationFrame = fn => setTimeout(fn, 0);
      const styles = { emptyState: { padding: 24 } };
      function Corner({ id, draft = '', noAgent = false, viewerIsAgent = false, conversation = false }) {
        const roomSurface = { members: noAgent ? [] : [
          { identity: { kind: 'person', handle: 'owner', pubkey: 'owner' } },
          { identity: { kind: 'agent', handle: 'beebee', pubkey: 'beebee-key' } },
          { identity: { kind: 'agent', handle: 'other', pubkey: 'other-key' } }
        ] };
        const isCorner = true, isDirectMessage = false, emptyLedgerVariant = 'corner';
        const displayRoomName = '', roomName = '', starterPrompts = undefined, starterIntro = undefined;
        const transcriptMessages = [ { systemEvent: { kind: 'corner-opened' } },
          { systemEvent: { kind: 'workflow-handoff' } }, ...(conversation ? [{}] : []) ];
        const composerRef = useRef(null), inputTextRef = useRef(draft);
        const selectedAgentMentionsRef = useRef(new Map()), selectedMentionsRef = useRef(new Map());
        const [inputText, setInputText] = useState(draft);
        const [selection, setInputSelection] = useState(undefined);
        const focusComposer = useCallback(() => scheduleAnimationFrame(() => composerRef.current?.focus()), []);
        ${hooks}
        ${empty}
        window.registries ??= {};
        window.registries[id] = { agent: selectedAgentMentionsRef.current, all: selectedMentionsRef.current };
        return <View testID={id}>{emptyLedger}<TextInput ref={composerRef} value={inputText}
          style={{ ...theme.type.body, color: theme.textPrimary, padding: theme.space.md }}
          onChangeText={setInputText} selection={selection} accessibilityLabel={id + ' composer'} /></View>;
      }
      createRoot(document.getElementById('root')).render(<>
        <Corner id="empty"/><Corner id="draft" draft="Keep my thought"/>
        <Corner id="fallback" noAgent/><Corner id="agent" viewerIsAgent/><Corner id="conversation" conversation/>
      </>);
      const result = {};
      setTimeout(async () => {
        for (const id of ['empty', 'draft', 'fallback']) {
          const root = document.querySelector('[data-testid="' + id + '"]');
          root.querySelector('[role="button"]').click();
          await new Promise(resolve => setTimeout(resolve, 80));
          result[id] = { text: root.textContent, draft: root.querySelector('textarea,input').value,
            focused: document.activeElement === root.querySelector('textarea,input'),
            mentions: [...window.registries[id].all], agents: [...window.registries[id].agent] };
        }
        result.agentHidden = !document.querySelector('[data-testid="agent"] [role="button"]');
        result.conversationHidden = !document.querySelector('[data-testid="conversation"] [role="button"]');
        document.getElementById('result').textContent = JSON.stringify(result);
      }, 500);`);
    for (const width of [390, 1180]) {
      const proof = await runBrowserProof({ entry, mobile, width, shims: webProofShims(mobile),
        screenshotPath: process.env.EMPTY_CORNER_EVIDENCE_DIR
          ? path.join(process.env.EMPTY_CORNER_EVIDENCE_DIR, `web-${width}.png`) : undefined,
      });
      expect(proof.status, proof.stderr).toBe(0);
      expect(JSON.parse(proof.result)).toEqual({
        empty: { text: 'Tag @beebee to startAgents here reply only when tagged.Tag @beebee to start', draft: '@beebee ', focused: true, mentions: [['beebee', 'beebee-key']], agents: [['beebee', 'beebee-key']] },
        draft: { text: 'Tag @beebee to startAgents here reply only when tagged.Tag @beebee to start', draft: 'Keep my thought', focused: true, mentions: [], agents: [] },
        fallback: { text: 'Tag an agent to startAgents here reply only when tagged.Tag an agent to start', draft: '', focused: true, mentions: [], agents: [] },
        agentHidden: true, conversationHidden: true,
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
