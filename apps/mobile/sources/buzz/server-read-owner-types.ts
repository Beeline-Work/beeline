import type { NeedsYouItemView, MessageBookmarkView } from '@beeline/api-contract/phone';

  export type NeedsYouLiveDelta = {
    readonly workspaceId: string;
    readonly sourceRoomId: string;
    readonly count: number;
    readonly items: readonly NeedsYouItemView[];
  };

  export type BookmarkDelta = {
    readonly messageId: string;
    readonly bookmark: MessageBookmarkView | null;
  };


  export type Entry = {
    needs: readonly NeedsYouItemView[] | null;
    saved: readonly MessageBookmarkView[] | null;
    next?: string;
  };

  /** A covering read replays only later committed live changes. */
  export type Change = { at: number; kind: 'needs' | 'saved'; apply: (entry: Entry) => Entry };

  export type Slot = {
    key: string;
    relay: string;
    pubkey: string;
    workspaceId: string;
    /** One order for both sections, covering reads and committed live changes. */
    entry: Entry;
    clock: number;
    needsRead: number;
    savedRead: number;
    reads: Set<number>;
    changes: Change[];
    projectionRead?: Promise<readonly NeedsYouItemView[]>;
    trayRead?: Promise<{ needsError?: string; savedError?: string }>;
    needsStale?: number;
    forgotten?: boolean;
    seen?: Set<string>;
    seeing?: Set<string>;
  };

  // Pending gestures contain IDs only. They never enter the response journal or disk.
  export type HiddenIntent = { ids: Set<string>; settled: boolean };
