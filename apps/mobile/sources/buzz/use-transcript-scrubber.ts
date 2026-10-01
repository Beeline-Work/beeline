import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RoomHistoryOutline } from '@beeline/api-contract/phone';
import { messageBoundaryIds } from './room-new-message-boundary';
import type { ChatDisplayMessage } from './room-view-presentation';
import { scrubberHistory, scrubberPosition } from './transcript-scrubber';

/** The server cuts the outline's days in this zone, the one the transcript's dates use. */
function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** How long the bar stays after the list stops, long enough to press and hold it. */
export const SCRUBBER_LINGER_MS = 2_000;

/**
 * State for `TranscriptScrubber`: the Room's history outline, read once per
 * visit, and where the reader sits in it. `durableMessages` are the server
 * rows the phone holds, oldest first — the same rows the outline counts.
 */
export function useTranscriptScrubber({
  roomId,
  roomClient,
  durableMessages,
}: {
  roomId: string;
  roomClient: { outline(id: string, timeZone: string): Promise<RoomHistoryOutline | null> } | null;
  durableMessages: readonly ChatDisplayMessage[];
}) {
  const [outline, setOutline] = useState<RoomHistoryOutline | null>(null);
  const [visibleIds, setVisibleIds] = useState<readonly string[]>([]);
  const [visible, setVisible] = useState(false);
  const lingerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setOutline(null);
    setVisibleIds([]);
    if (!roomClient || !roomId) return;
    let current = true;
    roomClient
      .outline(roomId, deviceTimeZone())
      .then((next) => {
        if (current && next?.roomId === roomId) setOutline(next);
      })
      // Without an outline the bar falls back to the loaded rows.
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [roomClient, roomId]);

  useEffect(
    () => () => {
      if (lingerRef.current) clearTimeout(lingerRef.current);
    },
    [],
  );

  const loadedIds = useMemo(
    () =>
      durableMessages
        // The outline, like history paging, skips unsettled activity rows.
        .filter((message) => !message.isAgentActivity || message.durableFact)
        .map((message) => message.id),
    [durableMessages],
  );
  const history = useMemo(() => scrubberHistory(outline, loadedIds), [loadedIds, outline]);
  const position = useMemo(() => scrubberPosition(history, visibleIds), [history, visibleIds]);

  const observeVisibleRows = useCallback((rows: readonly ChatDisplayMessage[]) => {
    setVisibleIds(rows.flatMap(messageBoundaryIds));
  }, []);

  const revealOnScroll = useCallback(() => {
    setVisible(true);
    if (lingerRef.current) clearTimeout(lingerRef.current);
    lingerRef.current = setTimeout(() => setVisible(false), SCRUBBER_LINGER_MS);
  }, []);

  return { history, position, visible, observeVisibleRows, revealOnScroll };
}
