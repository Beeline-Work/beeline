import React from 'react';
import { View } from 'react-native';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { StarPromptCard, useStarPrompt } from '../sources/components/buzz/StarPromptCard';
import { beelineThemes } from '../sources/buzz/groknight';

/**
 * The GitHub star card as the chat surface mounts it: the real hook reads the
 * server's `readStarPrompt`, and a tap answers through `answerStarPrompt`.
 * `?tap=star|later|dismiss` presses that control once the card paints.
 */
const tap = new URLSearchParams(location.search).get('tap');
const opened: string[] = [];
window.open = ((url?: string | URL) => {
  opened.push(String(url));
  return null;
}) as typeof window.open;

const pause = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));
const report = (text: string) => {
  document.getElementById('result')!.textContent = text;
};

function Harness() {
  const star = useStarPrompt('newest', true);
  return (
    <View style={{ backgroundColor: beelineThemes.obsidian.bgBase, padding: 16 }}>
      {star.prompt ? (
        <StarPromptCard
          prompt={star.prompt}
          busy={star.busy}
          onAnswer={(action) => void star.answer(action)}
        />
      ) : null}
    </View>
  );
}

async function run() {
  createRoot(document.getElementById('root')!).render(<Harness />);
  await pause();
  await pause();
  const card = document.querySelector<HTMLElement>('[data-testid="star-prompt"]');
  if (!card) {
    report('NO CARD');
    return;
  }
  const shown = (card.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (!tap) {
    report(`PASS shown: ${shown}`);
    return;
  }
  const control = document.querySelector<HTMLElement>(
    tap === 'dismiss' ? '[data-testid="star-prompt-dismiss"]' : `[data-testid="star-prompt-${tap}"]`,
  );
  if (!control) throw new Error(`no ${tap} control`);
  control.click();
  await pause();
  await pause();
  const after = document.querySelector('[data-testid="star-prompt"]') ? 'card still shown' : 'card gone';
  const answers = (window as typeof window & { __answers?: unknown[] }).__answers;
  report(
    `PASS shown: ${shown} | tapped ${tap} | ${after} | opened: ${opened.join(',') || 'nothing'}${answers ? ` | sent: ${JSON.stringify(answers)}` : ''}`,
  );
}

run().catch((error) => report(String(error)));
