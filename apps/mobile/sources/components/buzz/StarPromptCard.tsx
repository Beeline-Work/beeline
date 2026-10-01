import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { StarPrompt, StarPromptAction } from '@beeline/api-contract/phone';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { openExternalUrl } from '@/utils/open-external-url';
import { TranscriptCard } from './TranscriptCard';

const STAR_PROMPT_TITLE = 'Star Beeline on GitHub';
const STAR_PROMPT_STAR_LABEL = 'Star';
const STAR_PROMPT_LATER_LABEL = 'Not now';

function starPromptBody(milestone: number): string {
  return `Your agents have answered you ${milestone} times. If Beeline is useful to you, a star helps other people find it.`;
}

/**
 * The server decides when the card is due (`apps/server/src/github-star-prompt.ts`);
 * this asks again whenever the newest message changes, because a win (an
 * artifact, a 👍, a landed corner) arrives as a new message or reaction.
 */
export function useStarPrompt(newestMessageKey: string | undefined, enabled: boolean) {
  const [prompt, setPrompt] = useState<StarPrompt | null>(null);
  const [busy, setBusy] = useState<StarPromptAction | null>(null);
  // An answer outdates every read started before it; later reads still ask,
  // so the next milestone shows in the same open chat after Not now.
  const answers = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    const asked = answers.current;
    monolithPhoneOperation('readStarPrompt', {})
      .then((view) => {
        if (current && asked === answers.current) setPrompt(view.prompt);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [enabled, newestMessageKey]);
  const answer = useCallback(
    async (action: StarPromptAction) => {
      if (!prompt || busy) return;
      setBusy(action);
      try {
        const result = await monolithPhoneOperation('answerStarPrompt', {
          action,
          milestone: prompt.milestone,
        });
        answers.current += 1;
        setPrompt(null);
        if (result.outcome === 'open' && result.url)
          await openExternalUrl(result.url).catch(() => undefined);
      } catch {
        // The card stays; the person can try again.
      } finally {
        setBusy(null);
      }
    },
    [busy, prompt],
  );
  return { prompt, busy, answer };
}

export const StarPromptCard = memo(function StarPromptCard({
  prompt,
  busy,
  onAnswer,
}: {
  prompt: StarPrompt;
  busy: StarPromptAction | null;
  onAnswer(action: StarPromptAction): void;
}) {
  return (
    <TranscriptCard
      tier="ask"
      title={STAR_PROMPT_TITLE}
      body={starPromptBody(prompt.milestone)}
      footerNote={prompt.repository}
      footerNoteTestID="star-prompt-repository"
      onDismiss={() => onAnswer('dismiss')}
      dismissLabel="Don't ask again"
      actions={[
        {
          label: STAR_PROMPT_LATER_LABEL,
          onPress: () => onAnswer('later'),
          disabled: busy !== null,
          loading: busy === 'later',
          testID: 'star-prompt-later',
        },
        {
          label: `★ ${STAR_PROMPT_STAR_LABEL}`,
          primary: true,
          onPress: () => onAnswer('star'),
          disabled: busy !== null,
          loading: busy === 'star',
          testID: 'star-prompt-star',
        },
      ]}
      testID="star-prompt"
    />
  );
});
