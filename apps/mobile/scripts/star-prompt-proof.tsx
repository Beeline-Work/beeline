import React from 'react';
import { View } from 'react-native';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { StarPromptCard, useStarPrompt } from '../sources/components/buzz/StarPromptCard';
import { beelineThemes } from '../sources/buzz/groknight';

/**
 * The GitHub star card as the chat surface mounts it: the real hook reads the
 * opening `readStarPrompt`, then accepts pushed eligibility. A tap answers
 * through `answerStarPrompt`.
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
  const globals = window as typeof window & {
    __newMessage?: () => void;
    __starPromptLive?: (event: unknown) => void;
  };
  // A later win's server projection arrives in the same Room without a read.
  globals.__newMessage = () => globals.__starPromptLive?.({ monolithLive: {
    type: 'message-delta', roomId: 'proof-room', starPrompt: {
      milestone: 30, repository: 'Beeline-Work/beeline', url: 'https://github.com/Beeline-Work/beeline',
    },
  } });
  const star = useStarPrompt('proof-room', true);
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

// Headless virtual time does not drive display frames. Keep this functional
// proof on the same timer-driven frame clock as notification-landing-proof.
function installFrameClock() {
  const frames = new Map<number, ReturnType<typeof setTimeout>>();
  let next = 0;
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
    const handle = ++next;
    frames.set(handle, setTimeout(() => {
      frames.delete(handle);
      callback(performance.now());
    }, 16));
    return handle;
  };
  globalThis.cancelAnimationFrame = (handle: number) => {
    clearTimeout(frames.get(handle));
    frames.delete(handle);
  };
}

async function run() {
  installFrameClock();
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
    const close = card.querySelector('[data-testid="star-prompt-dismiss"] svg') ? 'drawn close' : 'no close';
    report(`PASS shown: ${shown} | ${close}`);
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
  (window as typeof window & { __newMessage?: () => void }).__newMessage?.();
  await pause();
  await pause();
  const next = document.querySelector<HTMLElement>('[data-testid="star-prompt"]');
  const reread = next ? (next.textContent ?? '').replace(/\s+/g, ' ').trim() : 'no card';
  const answers = (window as typeof window & { __answers?: unknown[] }).__answers;
  const reads = (window as typeof window & { __starPromptReads?: number }).__starPromptReads;
  report(
    `PASS shown: ${shown} | tapped ${tap} | ${after} | opened: ${opened.join(',') || 'nothing'}${answers ? ` | sent: ${JSON.stringify(answers)}` : ''} | after a new message: ${reread} | prompt reads: ${reads}`,
  );
}

run().catch((error) => report(String(error)));
