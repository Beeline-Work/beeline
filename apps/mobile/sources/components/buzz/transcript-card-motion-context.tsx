import React, { createContext, useContext, type ReactNode } from 'react';

export type TranscriptCardMotionSnapshot = {
  title: string | null;
  rows: ReadonlyMap<string, string>;
};

export type TranscriptCardMotionStore = {
  snapshots: Map<string, TranscriptCardMotionSnapshot>;
  settleStartedAt: Map<string, number>;
};

export function createTranscriptCardMotionStore(): TranscriptCardMotionStore {
  return { snapshots: new Map(), settleStartedAt: new Map() };
}

type TranscriptCardMotionContextValue = {
  arriving: boolean;
  cardId: string | null;
  store: TranscriptCardMotionStore | null;
};

const TranscriptCardMotionContext = createContext<TranscriptCardMotionContextValue>({
  arriving: false,
  cardId: null,
  store: null,
});

/** The list boundary supplies the consume-once verdict for this message id. */
export function TranscriptCardMotionBoundary({
  arriving,
  cardId,
  store,
  children,
}: {
  arriving: boolean;
  cardId: string;
  store: TranscriptCardMotionStore;
  children: ReactNode;
}) {
  return (
    <TranscriptCardMotionContext.Provider value={{ arriving, cardId, store }}>
      {children}
    </TranscriptCardMotionContext.Provider>
  );
}

export function useTranscriptCardMotion(): TranscriptCardMotionContextValue {
  return useContext(TranscriptCardMotionContext);
}
