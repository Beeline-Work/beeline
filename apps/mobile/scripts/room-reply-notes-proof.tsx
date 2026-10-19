import React from 'react';
import { View } from 'react-native';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import type { AgentActivityItem } from '../sources/sync/transport/rig-transport';
import { TurnStepsLine } from '../sources/components/buzz/ActivityTimeline';
import { LedgerEntry } from '../sources/components/buzz/Ledger';
import { beelineThemes } from '../sources/buzz/groknight';

/**
 * A Room reply as `RoomMessageVariants` composes it: the real `LedgerEntry`
 * with the reply's `TurnStepsLine` in its `machineNoise` slot, under the
 * prose. `?scene=collapsed|expanded|answer-first`.
 */
const scene = new URLSearchParams(location.search).get('scene') ?? 'collapsed';
const theme = beelineThemes.obsidian;
document.body.style.background = theme.bgBase;
document.getElementById('root')!.style.padding = '16px';
document.getElementById('result')!.style.display = 'none';

const tool = (id: string, title: string, toolKind: string): AgentActivityItem => ({
  kind: 'tool',
  id,
  title,
  toolKind,
  status: 'completed',
});
const note = (id: string, text: string): AgentActivityItem => ({
  kind: 'note',
  id,
  title: 'Note',
  text,
});

const scenes: Record<string, { items: AgentActivityItem[]; reply: string }> = {
  collapsed: {
    items: [
      note('n1', 'Now close the Play declaration corner.'),
      tool('t1', 'ToolSearch', 'search'),
      tool('t2', 'close_corner', 'other'),
      note(
        'n2',
        "I'll check the corner's blocker before deciding whether it needs to resume or stay parked.",
      ),
      tool('t3', 'corner_status', 'other'),
      tool('t4', 'order', 'other'),
    ],
    reply:
      "@lunchboxfortwo I've updated the conversation-keep-awake corner to do all three changes in one PR. Its session hasn't started yet.\n\nI closed the Play declaration corner. Nothing went to Google.",
  },
  'answer-first': {
    // The answer was the last text the agent wrote; one more tool call came
    // after it with no text. The answer is the reply, not a note.
    items: [
      note('n1', 'Checking the release state first.'),
      tool('t1', 'corner_brief', 'other'),
      tool('t2', 'react_to_message', 'other'),
    ],
    reply:
      '**Release plan.** Ship #2615 and this fix over the air once PR #2622 merges. The server-side fixes still wait on PR #2620.',
  },
};
const chosen = scenes[scene === 'expanded' ? 'collapsed' : scene]!;

function Reply() {
  return (
    <View style={{ maxWidth: 420 }}>
      <LedgerEntry
        itemId="reply"
        byline={{ name: 'ruby', role: 'opus 5.5', stamp: '10:42' }}
        chronological
        luminous
        bodyText={chosen.reply}
        bodyTestID="reply-text"
        machineNoise={<TurnStepsLine items={chosen.items} testID="reply-steps" />}
      />
    </View>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<Reply />);

if (scene === 'expanded') {
  setTimeout(() => {
    const group = document.querySelector('[data-testid^="tool-run-group-"]') as HTMLElement | null;
    group?.click();
  }, 300);
}
setTimeout(() => {
  const group = document.querySelector('[data-testid^="tool-run-group-"]');
  const notes = [...document.querySelectorAll('[data-testid^="tool-ledger-line-n"]')].map(
    (node) => node.textContent,
  );
  document.getElementById('result')!.textContent = JSON.stringify({
    summary: group?.textContent,
    notes,
  });
}, 900);
