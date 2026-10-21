import React from 'react';
// @ts-expect-error Browser proof uses installed react-dom.
import { createRoot } from 'react-dom/client';
// @ts-expect-error Browser proof uses installed react-dom.
import { flushSync } from 'react-dom';
import { View, Text, Pressable } from 'react-native';
import { ViewerConversationDock } from '../sources/components/buzz/ViewerConversationDock';
import { publishViewerConversation } from '../sources/buzz/viewer-conversation';
import type { RoomViewMessage } from '@beeline/api-contract/phone';
const text = '**FIRST LINE**\n\n' + Array.from({ length: 45 }, (_, i) => `- **State ${i+1}**: A long reply about call states and endings remains readable while the artifact stays visible.`).join('\n') + '\n\n**NEWEST LINE**';
const send = async () => {
  // Commit fixture delivery before Chrome advances virtual time again. The dock
  // still owns layout and scrolling; the proof never scrolls for it.
  setTimeout(() => flushSync(() => publishViewerConversation({ roomId: 'proof', messages: [{ id: 'reply', text, presentation: 'message', author: { kind: 'agent', handle: 'ruby', name: 'Ruby' } } as RoomViewMessage], send })), location.search.includes('slow-reply') ? 800 : 50);
  return true;
};
publishViewerConversation({ roomId: 'proof', messages: [], send });
createRoot(document.getElementById('root')!).render(<View style={{ height: '100vh' as any, backgroundColor: '#14091A' }}>
  <Pressable testID="viewer-control"><Text style={{ color: '#f0f0f3', marginTop: 30 }}>Call states and endings (1–9)</Text></Pressable>
  <ViewerConversationDock kind="artifact" title="Call states and endings (1–9)" roomId="proof" agentHandle="ruby" />
</View>);
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const find = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
async function waitForReplyLayout() {
  const deadline = performance.now() + 3000;
  let lastLayout = '', stableSince = performance.now();
  for (;;) {
    const scroll = find('viewer-conversation-scroll');
    const layout = scroll ? `${scroll.scrollHeight}:${scroll.clientHeight}:${scroll.scrollTop}` : '';
    if (layout !== lastLayout) { lastLayout = layout; stableSince = performance.now(); }
    const atNewest = Boolean(scroll?.textContent?.includes('NEWEST LINE') && scroll.scrollTop > 0 &&
        Math.abs(scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop) < 3);
    if (atNewest && performance.now() - stableSince >= 150) return;
    // Chrome can jump virtual time past the deadline in the same tick the delayed
    // reply lands; keep polling while the newest line is already at the bottom.
    if (performance.now() >= deadline && !atNewest) break;
    await wait(25);
  }
  throw new Error('Reply did not arrive and scroll to the newest line within 3 seconds');
}
async function prove() {
  await Promise.all(['SpaceGrotesk-Regular', 'SpaceGrotesk-SemiBold', 'IBMPlexMono-Regular'].map(font => document.fonts.load(`16px ${font}`)));
  await wait(200); find('viewer-conversation-toggle').click();
  await wait(250); find('proof-send').click();
  // ResizeObserver and React layout can finish after an arbitrary timer in CI.
  // Observe the reply and automatic scroll; never scroll it on the proof's behalf.
  if (location.search.includes('baseline')) await wait(500);
  else await waitForReplyLayout();
  const panel = find('viewer-conversation-transcript'), scroll = find('viewer-conversation-scroll');
  const checks: Record<string, boolean | number> = { panelHeight: panel.getBoundingClientRect().height, windowHeight: innerHeight };
  if (location.search.includes('baseline')) {
    checks.overflow = panel.getBoundingClientRect().height > innerHeight * .4;
    checks.noScroll = !scroll;
    checks.rawMarkdown = panel.textContent!.includes('**FIRST LINE**');
  } else {
    checks.capped = panel.getBoundingClientRect().height <= innerHeight * .4;
    checks.scrolls = scroll.scrollHeight > scroll.clientHeight;
    checks.newest = scroll.scrollTop > 0 && Math.abs(scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop) < 3;
    checks.formatted = !panel.textContent!.includes('**') && !!panel.textContent!.includes('FIRST LINE');
    checks.bold = Array.from(panel.querySelectorAll('*')).some(el => el.textContent === 'FIRST LINE' && getComputedStyle(el).fontFamily.includes('SemiBold'));
    if (!location.search.includes('newest')) scroll.scrollTop = 0;
    await wait(100);
    checks.composerSeparate = find('viewer-conversation-pill').getBoundingClientRect().top > panel.getBoundingClientRect().bottom;
    const rect = find('viewer-control').getBoundingClientRect();
    checks.viewerTappable = !!document.elementFromPoint(rect.x+10, rect.y+10)?.closest('[data-testid="viewer-control"]');
    if (!location.search.includes('newest')) {
      checks.firstLineReachable = scroll.scrollTop === 0;
      const first = Array.from(scroll.querySelectorAll('*')).find(el => el.textContent === 'FIRST LINE')!;
      checks.firstLineVisible = first.getBoundingClientRect().top >= scroll.getBoundingClientRect().top;
    }
  }
  document.getElementById('result')!.textContent = `RESULT ${Object.values(checks).every(v => typeof v === 'number' || v) ? 'PASS' : 'FAIL'} ${JSON.stringify(checks)}`;
}
prove().catch(e => { document.getElementById('result')!.textContent = String(e.stack); });
