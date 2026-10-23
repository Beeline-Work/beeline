import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { loadUntaggedHintCount, reserveUntaggedHint, retireUntaggedHints } from './untagged-hint-storage';

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
  active?: boolean | (() => boolean);
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

  const hintGeneration = useRef(0);
  const ready = useRef<object | null>(null);
  const recorded = useMemo(() => new Set<string>(), [session]);
  useEffect(() => {
    ready.current = null;
    let cancelled = false;
    const generation = hintGeneration.current;
    void loadUntaggedHintCount(viewerPubkey).then(count => {
      if (!cancelled && count < 2 && hintGeneration.current === generation) ready.current = session;
    }).catch(() => {});
    return () => { cancelled = true; ready.current = null; };
  }, [session, viewerPubkey]);

  // Capture before awaiting the send. A receipt arriving after navigation must
  // not put a hint back into a conversation the sender already left.
  const captureSend = useCallback((hasMentions: boolean) => {
    const visitGeneration = hintGeneration.current;
    return (messageId: string) => {
      if (hintGeneration.current !== visitGeneration || !enabled || !(typeof active === 'function' ? active() : active) || currentSession.current !== session) return;
      if (hasMentions) {
        hintGeneration.current += 1;
        ready.current = null;
        void retireUntaggedHints(viewerPubkey);
        setHints({ session, ids: NO_HINTS });
        return;
      }
      if (ready.current !== session || recorded.has(messageId)) return;
      recorded.add(messageId);
      const generation = hintGeneration.current;
      void reserveUntaggedHint(viewerPubkey).then(allowed => {
        if (!allowed || !(typeof active === 'function' ? active() : active) || currentSession.current !== session || hintGeneration.current !== generation) return;
        setHints(previous => ({ session, ids: new Set([
          ...(previous?.session === session ? previous.ids : []), messageId,
        ]) }));
      });
    };
  }, [active, enabled, session, recorded, viewerPubkey]);
  const endVisit = useCallback(() => {
    hintGeneration.current += 1;
    setHints(undefined);
  }, []);

  return {
    captureSend,
    endVisit,
    hintMessageIds: enabled && (typeof active === 'function' ? active() : active) && hints?.session === session ? hints.ids : NO_HINTS,
  };
}
