import { describe, expect, it, vi } from 'vitest';
import { generateKeypair, type Keypair } from '@beeline/nostr';
import {
  describeGitHubRepoEvents,
  runGitHubEventWatcher,
  type GitHubEventWatcherDeps,
  type GitHubRepoEvent,
} from './github-events.js';
import type { GitHubRoomEventsResult } from '@beeline/buzz-client';
import { newIdentity } from '@beeline/gate';
import { Body } from './body.js';

function event(overrides: Partial<GitHubRepoEvent> = {}): GitHubRepoEvent {
  return {
    id: 1,
    type: 'star',
    action: 'created',
    actor: 'lena',
    summary: 'lena starred octocat/widget',
    received_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

interface HarnessOptions {
  /** Pages served in order for successive `since`-reads. */
  pages?: GitHubRepoEvent[][];
  /** What the bootstrap read (no `since`) reports as the current position. */
  bootstrapCursor?: number;
  /** Pre-seeded cursor; `undefined` (default) forces the bootstrap path. */
  initialCursor?: number;
  enabled?: () => boolean;
  /** Number of leading post() calls that throw. */
  failPosts?: number;
}

/**
 * Drive one watcher to completion: when the scripted pages run out the harness
 * aborts the loop's signal, so the loop finishes the page it is holding and
 * exits cleanly.
 */
async function harness(options: HarnessOptions = {}) {
  const posted: string[] = [];
  const savedCursors: number[] = [];
  const identity = await generateKeypair();
  const controller = new AbortController();
  let pageIndex = 0;
  let postAttempts = 0;
  const pages = options.pages ?? [];
  let cursor: number | undefined = options.initialCursor;
  // The bootstrap read persists its position, then `since` reads begin.
  let sinceCursor: number | undefined;

  const fetchEvents = async (
    _baseUrl: string,
    _identity: Pick<Keypair, 'secretKey' | 'publicKey'>,
    _roomId: string,
    opts?: { since?: number; waitMs?: number },
  ): Promise<GitHubRoomEventsResult> => {
    if (opts?.since === undefined) {
      sinceCursor = 0;
      return {
        fullName: 'octocat/widget',
        head: options.bootstrapCursor ?? 0,
        cursor: options.bootstrapCursor ?? 0,
        events: [],
      };
    }
    sinceCursor = opts.since;
    // An over-read (past every scripted page) ends the harness: nothing new
    // will ever arrive, so abort and let the loop exit cleanly.
    if (pageIndex >= pages.length) {
      controller.abort();
      return { fullName: 'octocat/widget', head: opts.since, cursor: opts.since, events: [] };
    }
    const page = pages[pageIndex]!;
    pageIndex += 1;
    return {
      fullName: 'octocat/widget',
      head: page.at(-1)?.id ?? opts.since,
      cursor: page.at(-1)?.id ?? opts.since,
      events: page,
    };
  };

  const deps: GitHubEventWatcherDeps = {
    roomId: 'room-1',
    fullName: 'octocat/widget',
    identity,
    baseUrl: 'https://relay.example',
    eventsEnabled: async () => options.enabled?.() ?? true,
    post: async (text) => {
      postAttempts += 1;
      if (postAttempts <= (options.failPosts ?? 0)) throw new Error('transient relay refusal');
      posted.push(text);
    },
    loadCursor: async () => cursor,
    saveCursor: async (id) => {
      cursor = id;
      savedCursors.push(id);
    },
    signal: controller.signal,
    fetchEvents,
    now: () => 1_000,
    sleep: async () => {},
  };
  await runGitHubEventWatcher(deps);
  return { posted, savedCursors, sinceCursor: () => sinceCursor, postAttempts };
}

describe('describeGitHubRepoEvents', () => {
  it('composes one compact line per event and appends the link for a single event', () => {
    expect(
      describeGitHubRepoEvents([
        event({
          summary: 'lena opened issue #12 in octocat/widget: Fix login',
          url: 'https://github.com/octocat/widget/issues/12',
        }),
      ]),
    ).toBe(
      'lena opened issue #12 in octocat/widget: Fix login\nhttps://github.com/octocat/widget/issues/12',
    );
  });

  it('keeps a batch to bare lines so a burst lands as one readable card', () => {
    const text = describeGitHubRepoEvents([
      event({ id: 1, summary: 'lena starred octocat/widget', url: 'https://x/1' }),
      event({ id: 2, type: 'issues', summary: 'lena closed issue #12 in octocat/widget' }),
      event({
        id: 3,
        type: 'pull_request',
        summary: 'lena merged pull request #34 in octocat/widget',
      }),
    ]);
    expect(text).toBe(
      'lena starred octocat/widget\nlena closed issue #12 in octocat/widget\nlena merged pull request #34 in octocat/widget',
    );
  });

  it('caps a flood at ten lines plus an honest overflow count', () => {
    const flood = Array.from({ length: 25 }, (_, index) =>
      event({ id: index + 1, summary: `event ${index + 1}` }),
    );
    const lines = describeGitHubRepoEvents(flood)!.split('\n');
    expect(lines).toHaveLength(11);
    expect(lines[10]).toBe('… and 15 more repository updates');
  });

  it('says nothing for an empty batch', () => {
    expect(describeGitHubRepoEvents([])).toBeUndefined();
  });
});

describe('runGitHubEventWatcher', () => {
  it('bootstraps its cursor from "now" on first contact, then serves new events', async () => {
    const { posted, savedCursors } = await harness({
      bootstrapCursor: 7,
      pages: [[event({ id: 9 })]],
    });
    // Bootstrap position persisted first (start from NOW, not from history).
    expect(savedCursors[0]).toBe(7);
    expect(posted).toEqual(['lena starred octocat/widget']);
    expect(savedCursors).toEqual([7, 9]);
  });

  it('fans one repository out to each Room independently', async () => {
    // Two Rooms bound to the same repo each run their own watcher with their
    // own cursor; both must publish the same repository event.
    const sharedPage = [event({ id: 5 })];
    const makeWatcher = async (roomId: string) => {
      const posted: string[] = [];
      const controller = new AbortController();
      let served = false;
      await runGitHubEventWatcher({
        roomId,
        fullName: 'octocat/widget',
        identity: await generateKeypair(),
        baseUrl: 'https://relay.example',
        eventsEnabled: async () => true,
        post: async (text) => posted.push(text),
        loadCursor: async () => 0,
        saveCursor: async () => {},
        fetchEvents: async (_b, _i, _r, opts) => {
          if (opts?.since === undefined) {
            return { fullName: 'octocat/widget', head: 0, cursor: 0, events: [] };
          }
          if (served) {
            controller.abort();
            return { fullName: 'octocat/widget', head: 5, cursor: 5, events: [] };
          }
          served = true;
          return { fullName: 'octocat/widget', head: 5, cursor: 5, events: sharedPage };
        },
        signal: controller.signal,
        now: () => 1_000,
      });
      return posted;
    };
    const [roomA, roomB] = await Promise.all([makeWatcher('room-a'), makeWatcher('room-b')]);
    expect(roomA).toEqual(['lena starred octocat/widget']);
    expect(roomB).toEqual(roomA);
  });

  it('posts nothing while the Room toggle is OFF, then delivers late when re-enabled', async () => {
    const posted: string[] = [];
    const savedCursors: number[] = [];
    let enabled = false;
    let polls = 0;
    const controller = new AbortController();
    const done = runGitHubEventWatcher({
      roomId: 'room-1',
      fullName: 'octocat/widget',
      identity: await generateKeypair(),
      baseUrl: 'https://relay.example',
      eventsEnabled: async () => enabled,
      post: async (text) => posted.push(text),
      loadCursor: async () => 4,
      saveCursor: async (id) => savedCursors.push(id),
      fetchEvents: (async () => {
        polls += 1;
        controller.abort();
        return { fullName: 'octocat/widget', head: 9, cursor: 9, events: [event({ id: 9 })] };
      }) as typeof import('@beeline/buzz-client').getGitHubRoomEvents,
      signal: controller.signal,
      now: () => 1_000,
      sleep: async (ms) => {
        // The OFF park must be interruptible in tests, not a real 5-minute wait.
        if (ms > 1_000) await new Promise((resolve) => setTimeout(resolve, 5));
      },
    });
    // Let the loop reach the toggle check and park itself while OFF.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(posted).toEqual([]);
    expect(polls).toBe(0); // nothing fetched while OFF

    enabled = true;
    await done;

    // Late delivery from the frozen cursor once back ON.
    expect(posted).toEqual(['lena starred octocat/widget']);
    expect(savedCursors).toEqual([9]);
    expect(polls).toBe(1);
  });

  it('retries an unpublished batch before advancing its cursor, then never reposts', async () => {
    const { posted, savedCursors, postAttempts } = await harness({
      pages: [[event({ id: 2 })]],
      failPosts: 1,
    });
    expect(postAttempts).toBe(2);
    expect(posted).toEqual(['lena starred octocat/widget']);
    // Cursor advanced exactly once, only after the card actually published.
    expect(savedCursors).toEqual([0, 2]);
  });

  it('drops an undeliverable batch after bounded retries, with a logged reason', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { posted, savedCursors, postAttempts } = await harness({
        pages: [[event({ id: 2 })]],
        failPosts: 99, // never succeeds
      });
      expect(posted).toEqual([]);
      expect(postAttempts).toBe(3); // 1 initial + 2 retries, then dropped before a 4th
      expect(savedCursors).toEqual([0, 2]); // bootstrap position, then advance with the drop logged
      expect(
        errorSpy.mock.calls.some((call) =>
          String(call[0]).includes('dropping 1 undeliverable event'),
        ),
      ).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('stops permanently with one console line when the feed does not exist on this relay', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const sleeps: number[] = [];
      await runGitHubEventWatcher({
        roomId: 'room-1',
        fullName: 'octocat/widget',
        identity: await generateKeypair(),
        baseUrl: 'https://relay.example',
        eventsEnabled: async () => true,
        post: async () => {},
        loadCursor: async () => 0,
        saveCursor: async () => {},
        fetchEvents: async () => {
          throw new Error('auth service returned HTTP 404');
        },
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      });
      expect(sleeps).toEqual([]); // stopped rather than backed off forever
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0]?.[0]).toContain('feed unavailable');
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('Body wiring', () => {
  const config = {
    agentBinary: '/nonexistent',
    mcpBinary: '/nonexistent',
    agentEnv: {},
    workspaceRoot: '/tmp/buzzy-body-unit-github-events',
    relayBaseUrl: 'http://relay.test',
    relayHost: 'relay.test',
    relayScheme: 'http',
    relayWsUrl: 'ws://relay.test',
    autoApprovePermissions: true,
  } as unknown as Parameters<typeof Body>[0];

  function makeBody(): InstanceType<typeof Body> {
    return new Body(config, newIdentity('operator'));
  }

  it('starts the feed for a GitHub-bound Room and never for a non-GitHub one', async () => {
    const fetchCalls: Array<{ roomId?: string } | undefined> = [];
    const body = makeBody();
    body.githubEventsTestDeps = {
      eventsEnabled: async () => true,
      post: async () => {},
      loadCursor: async () => 0,
      saveCursor: async () => {},
      fetchEvents: (async (_b, _i, roomId) => {
        fetchCalls.push({ roomId });
        throw new Error('auth service returned HTTP 404');
      }) as typeof import('@beeline/buzz-client').getGitHubRoomEvents,
    };

    // A GitHub canonical binding remote starts the feed.
    (
      body as unknown as {
        startRoomGitHubEventsLoop: (id: string, repo: object) => void;
      }
    ).startRoomGitHubEventsLoop('room-gh', {
      repo: 'widget',
      truth: { binding: { key: 'k', name: 'widget', remote: 'git://github.com/acme/widget' } },
    });
    await vi.waitFor(() => expect(fetchCalls.length).toBe(1));
    expect(fetchCalls[0]?.roomId).toBe('room-gh');

    // A local-only repository has no webhook feed to consume at all.
    (
      body as unknown as {
        startRoomGitHubEventsLoop: (id: string, repo: object) => void;
      }
    ).startRoomGitHubEventsLoop('room-local', {
      repo: 'local',
      localOnly: true,
      truth: { binding: { key: 'l', name: 'local', localOnly: true } },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchCalls.length).toBe(1); // unchanged
  });

  it('starts the feed at most once per Room', async () => {
    const fetchCalls: unknown[] = [];
    const body = makeBody();
    body.githubEventsTestDeps = {
      eventsEnabled: async () => false,
      post: async () => {},
      loadCursor: async () => 0,
      saveCursor: async () => {},
      fetchEvents: (async () => {
        fetchCalls.push(undefined);
        throw new Error('unreachable');
      }) as typeof import('@beeline/buzz-client').getGitHubRoomEvents,
    };
    const start = (
      body as unknown as {
        startRoomGitHubEventsLoop: (id: string, repo: object) => void;
      }
    ).startRoomGitHubEventsLoop.bind(body);
    const boundRepo = {
      repo: 'widget',
      remoteUrl: 'https://github.com/acme/widget.git',
    };
    start('room-dup', boundRepo);
    start('room-dup', boundRepo);
    // Toggle OFF parks the loop without fetching; a second start is refused.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchCalls).toHaveLength(0);
  });
});
