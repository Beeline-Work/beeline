import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const NO_HINTS: ReadonlySet<string> = new Set();

/** Transient feedback for this device's sends, never derived from message history. */
export function useUntaggedMessageHints({
  roomId, viewerPubkey, viewerKind, hasAgentMembers, isDirectMessage = false, active = true,
}: {
  roomId: string;
  viewerPubkey: string;
  viewerKind?: 'human' | 'agent';
  hasAgentMembers: boolean;
  isDirectMessage?: boolean;
  active?: boolean;
}) {
  const enabled = viewerKind === 'human' && hasAgentMembers && !isDirectMessage;
  const session = useMemo(() => ({}), [roomId, viewerPubkey, enabled, active]);
  const currentSession = useRef<object | null>(session);
  currentSession.current = session;
  const [hints, setHints] = useState<{ session: object; ids: ReadonlySet<string> }>();
  useEffect(() => {
    currentSession.current = session;
    return () => { currentSession.current = null; };
  }, [session]);

  // Capture before awaiting the send. A receipt arriving after navigation must
  // not put a hint back into a conversation the sender already left.
  const captureSend = useCallback((hasMentions: boolean) => (messageId: string) => {
    if (!enabled || !active || currentSession.current !== session) return;
    setHints((previous) => {
      if (currentSession.current !== session) return previous;
      const ids = new Set(previous?.session === session ? previous.ids : []);
      if (hasMentions) ids.clear();
      else ids.add(messageId);
      return { session, ids };
    });
  }, [active, enabled, session]);

  return {
    captureSend,
    hintMessageIds: enabled && active && hints?.session === session ? hints.ids : NO_HINTS,
  };
}
