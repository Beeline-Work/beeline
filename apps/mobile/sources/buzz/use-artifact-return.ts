import { useCallback, useRef } from 'react';
import { useFocusEffect } from 'expo-router';

import type { ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { restoreTranscriptAnchor } from '@/buzz/transcript-presentation';

/** Keep a code reader's originating row restorable across route focus changes. */
export function useArtifactReturn({
  transcriptMessages,
  residentMessages,
  onReveal,
  onScroll,
}: {
  transcriptMessages: readonly ChatDisplayMessage[];
  residentMessages: readonly ChatDisplayMessage[];
  onReveal(rowsFromNewest: number): void;
  onScroll(index: number, viewPosition: number): void;
}): (messageId: string) => void {
  const returnMessageIdRef = useRef<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      const messageId = returnMessageIdRef.current;
      if (!messageId) return;
      restoreTranscriptAnchor({
        messageId,
        transcriptMessages,
        residentMessages,
        onReveal,
        onScroll: (index, viewPosition) => {
          returnMessageIdRef.current = null;
          onScroll(index, viewPosition);
        },
      });
    }, [onReveal, onScroll, residentMessages, transcriptMessages]),
  );

  return useCallback((messageId: string) => {
    returnMessageIdRef.current = messageId;
  }, []);
}
