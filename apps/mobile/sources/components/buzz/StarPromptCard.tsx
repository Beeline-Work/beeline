import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { StarPrompt, StarPromptAction } from '@beeline/api-contract/phone';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { sharedLiveConnection } from '@/sync/transport/live-connection';
import { openExternalUrl } from '@/utils/open-external-url';
import { TranscriptCard } from './TranscriptCard';

const STAR_PROMPT_TITLE = 'Star Beeline on GitHub';
const STAR_PROMPT_STAR_LABEL = 'Star';
const STAR_PROMPT_LATER_LABEL = 'Not now';

function starPromptBody(milestone: number): string {
  return `Your agents have answered you ${milestone} times. If Beeline is useful to you, a star helps other people find it.`;
}

/** Starred or closed in this app session: the server never shows the card again. */
let stoppedThisSession = false;

/** Eligibility is server-owned: one opening read, then mutation/live projections. */
export function useStarPrompt(roomId: string | undefined, enabled: boolean) {
  const [prompt, setPrompt] = useState<StarPrompt | null>(null);
  const [busy, setBusy] = useState<StarPromptAction | null>(null);
  // An answer outdates every read started before it; later reads still ask,
  // so the next milestone shows in the same open chat after Not now.
  const answers = useRef(0);
  const answeredMilestone = useRef(0);
  useEffect(() => {
    if (!enabled || stoppedThisSession) return;
    let current = true;
    const asked = answers.current;
    let frame: number | undefined;
    let remainingFrames = 4;
    // Leave two complete frames after the Room's two-frame ready marker.
    // That marker can precede the native buffer's actual commitment.
    const afterRoomPaint = () => {
      if (!current) return;
      if (--remainingFrames > 0) {
        frame = requestAnimationFrame(afterRoomPaint);
        return;
      }
      void monolithPhoneOperation('readStarPrompt', {})
        .then((view) => {
          if (current && asked === answers.current) setPrompt(view.prompt);
        })
        .catch(() => undefined);
    };
    frame = requestAnimationFrame(afterRoomPaint);
    return () => {
      current = false;
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [enabled, roomId]);
  const accept = useCallback((view: { prompt: StarPrompt | null }) => {
    answers.current += 1;
    if (!stoppedThisSession && (!view.prompt || view.prompt.milestone > answeredMilestone.current))
      setPrompt(view.prompt);
  }, []);
  useEffect(() => {
    if (!enabled || !roomId || stoppedThisSession) return;
    let cancelled = false;
    let stop: (() => void) | undefined;
    void sharedLiveConnection().register([{ '#h': [roomId] }], event => {
      if (!('monolithLive' in event)) return;
      const live = event.monolithLive;
      if (live.type === 'message-delta' && live.roomId === roomId && 'starPrompt' in live)
        accept({ prompt: live.starPrompt ?? null });
    }).then(release => { if (cancelled) release(); else stop = release; }).catch(() => undefined);
    return () => { cancelled = true; stop?.(); };
  }, [accept, enabled, roomId]);
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
        answeredMilestone.current = Math.max(answeredMilestone.current, prompt.milestone);
        if (action !== 'later') stoppedThisSession = true;
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
  return { prompt, busy, answer, accept };
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
          dismiss: true,
          onPress: () => onAnswer('later'),
          disabled: busy !== null,
          loading: busy === 'later',
          testID: 'star-prompt-later',
        },
        {
          label: STAR_PROMPT_STAR_LABEL,
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
