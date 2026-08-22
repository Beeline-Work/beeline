/**
 * A corner has to be able to say what it is for.
 *
 * The report was "at corner open there is no goal summary — just a literal dump
 * of the last room turns, indecipherable", and the live evidence explains it
 * exactly. The captain's corner `b3a9161a` was opened by a bare
 * `@beebee open corner`:
 *
 *   - `taskDescriptionFromCornerRequest` correctly distils a bare imperative to
 *     `''` — the message really does name no work — so the kind:9007 create
 *     event carries no `task` tag;
 *   - with no task there is no slug, so the corner is named `corner-1f6e289d`,
 *     which `cornerObjectiveLine` recognises as generated and refuses;
 *   - so the objective pin renders nothing, and a corner that has published
 *     almost nothing of its own leaves the ten quoted Room lines as the entire
 *     first screen.
 *
 * The fix is not to invent an objective. It is to use the person's own most
 * recent substantive words, which the daemon already has durably and already
 * seeds the corner's first turn with.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  cornerNameForIntent,
  cornerObjectiveFromConversation,
  slugifyCornerTask,
  taskDescriptionFromCornerRequest,
} from './body.js';
import { projectActivity } from './activity.js';
import type { AcpClient } from './acp.js';
import { newIdentity } from '@beeline/gate';
import type { NostrEvent } from '@beeline/nostr';

describe('a corner opened by a bare imperative still knows what it is for', () => {
  // Verbatim from the captain's Room, in order.
  const conversation = [
    { role: 'user', text: '@Beebee the offline banner fires when you are plainly not offline' },
    { role: 'agent', text: 'You were right — the misdiagnosis was upstream, in the daemon.' },
    { role: 'user', text: 'fix the presence model so a reconnect blip never asserts offline' },
    { role: 'user', text: '@beebee open corner' },
  ];

  it('confirms the trigger message really does name nothing', () => {
    expect(taskDescriptionFromCornerRequest('@beebee open corner')).toBe('');
    expect(cornerNameForIntent('@beebee open corner', '1f6e289d-d4d3')).toBe('corner-1f6e289d');
  });

  it('recovers the objective from the person’s own most recent substantive words', () => {
    expect(cornerObjectiveFromConversation(conversation)).toBe(
      'fix the presence model so a reconnect blip never asserts offline',
    );
  });

  it('names the corner and its branch from that recovered objective', () => {
    const slug = slugifyCornerTask(cornerObjectiveFromConversation(conversation));
    expect(slug).toBe('fix-the-presence-model-so-a-reconnect-blip');
    expect(slug).not.toMatch(/^corner-/);
  });

  it('never borrows the agent’s words, only the person’s', () => {
    expect(
      cornerObjectiveFromConversation([
        { role: 'agent', text: 'I have finished the presence work and pushed it for review.' },
        { role: 'user', text: 'open a corner' },
      ]),
    ).toBe('');
  });

  it('says nothing rather than something empty when the Room has no substance either', () => {
    expect(
      cornerObjectiveFromConversation([
        { role: 'user', text: '@beebee go' },
        { role: 'user', text: '@beebee open a corner' },
      ]),
    ).toBe('');
    expect(cornerObjectiveFromConversation([])).toBe('');
  });

  it('strips the stored attribution preamble before reading the objective', () => {
    expect(
      cornerObjectiveFromConversation([
        { role: 'user', text: 'Member @captain says: add a retry to the presence heartbeat' },
        { role: 'user', text: 'open corner' },
      ]),
    ).toBe('add a retry to the presence heartbeat');
  });

  it('is what `openSubchannel` actually falls back to, and it names the branch too', () => {
    // A source assertion, in the same spirit as the mobile design tests: the
    // recovery is only worth anything if the ONE place that writes the `task`
    // tag, the corner name and the feature branch is the place that uses it.
    // Proving the helper in isolation is what let the original gap ship.
    const source = readFileSync(
      fileURLToPath(new URL('./body.ts', import.meta.url)),
      'utf8',
    );
    const open = source.slice(source.indexOf('async openSubchannel('));
    const body = open.slice(0, open.indexOf('\n  }\n'));
    expect(body).toContain('cornerObjectiveFromConversation');
    // The name and the branch come from the resolved objective, not from the
    // raw trigger — otherwise a recovered objective still leaves a corner
    // called `corner-<parent>` on a branch called `feature/<uuid>`.
    expect(body).toContain('cornerObjectiveFromConversation(conversation)');
    expect(body).toContain('generated ? slugifyCornerTask(generated.title)');
    expect(body).toContain('const cornerName = generated?.title ??');
    expect(body).toContain('taskSlug\n      ? `feature/${taskSlug}-');
  });

  it('prefers the newest qualifying message, not the oldest', () => {
    expect(
      cornerObjectiveFromConversation([
        { role: 'user', text: 'first, rename the room list' },
        { role: 'user', text: 'actually, fix the merge approval path instead' },
        { role: 'user', text: 'ok open a corner' },
      ]),
    ).toBe('actually, fix the merge approval path instead');
  });
});

/**
 * The plan pin's checklist is only as live as the wire under it, and no plan
 * has ever reached the wire in the captain's Room — 83 activity events in
 * corner `8731c8ce`, zero carrying one. That could mean the harness never
 * planned, or that the daemon does not recognise the shape it plans in, and
 * those are very different problems. This pins the shape read VERBATIM out of
 * the installed `claude-agent-acp` (`dist/tools.js` → `planEntries`,
 * `dist/acp-agent.js` → the `TodoWrite` branch), so the answer stays "the
 * harness did not plan" and cannot quietly become "we stopped understanding
 * it".
 */
describe('the plan the installed harness actually emits reaches the wire', () => {
  const channelId = 'corner-channel';
  const sessionId = 'session-1';
  let owner: ReturnType<typeof newIdentity>;
  let client: EventEmitter;
  const published: NostrEvent[] = [];

  beforeEach(() => {
    published.length = 0;
    owner = newIdentity('agent');
    client = new EventEmitter();
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** The adapter's own mapping, so this test breaks if the adapter changes. */
  function adapterPlanShape(): Record<string, unknown> {
    return {
      sessionUpdate: 'plan',
      entries: [
        { content: 'Read the presence model', status: 'completed', priority: 'medium' },
        { content: 'Gate the offline marker', status: 'in_progress', priority: 'medium' },
        { content: 'Add a regression test', status: 'pending', priority: 'medium' },
      ],
    };
  }

  it('matches the shape the installed claude-agent-acp builds for TodoWrite', () => {
    // Not asserted from memory: read the adapter on disk. Skips rather than
    // fails when it is not installed, so CI without the harness stays green.
    let source: string;
    try {
      const require_ = createRequire(import.meta.url);
      source = readFileSync(
        require_.resolve('@agentclientprotocol/claude-agent-acp/dist/tools.js'),
        'utf8',
      );
    } catch {
      return;
    }
    expect(source).toContain('todos');
    expect(source).toContain('content: todo.content');
    expect(source).toContain('status: todo.status');
  });

  it('publishes the checklist as a plan on the summary event', async () => {
    const unsubscribe = projectActivity(
      client as unknown as AcpClient,
      channelId,
      owner,
      sessionId,
    );
    client.emit('session/update', { sessionId, update: adapterPlanShape() });
    await vi.advanceTimersByTimeAsync(6_000);
    unsubscribe();

    const summaries = published
      .map((event) => {
        try {
          return JSON.parse(event.content) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      })
      .filter((value): value is Record<string, unknown> => Boolean(value))
      .flatMap((value) => {
        const update = (value.update ?? {}) as Record<string, unknown>;
        return Array.isArray(update.updates) ? (update.updates as Record<string, unknown>[]) : [];
      })
      .filter((update) => update.plan);
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries[0]!.plan).toMatchObject({
      items: [
        { step: 'Read the presence model', status: 'completed' },
        { step: 'Gate the offline marker', status: 'in_progress' },
        { step: 'Add a regression test', status: 'pending' },
      ],
    });
  });

  it('sends a plan once, then again only when it actually changes', async () => {
    const unsubscribe = projectActivity(
      client as unknown as AcpClient,
      channelId,
      owner,
      sessionId,
    );
    client.emit('session/update', { sessionId, update: adapterPlanShape() });
    await vi.advanceTimersByTimeAsync(6_000);
    const afterFirst = published.length;
    // An unchanged plan restated on the next batch must not cost another write.
    client.emit('session/update', { sessionId, update: adapterPlanShape() });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(published.length).toBe(afterFirst);

    const advanced = adapterPlanShape();
    (advanced.entries as Record<string, unknown>[])[1]!.status = 'completed';
    client.emit('session/update', { sessionId, update: advanced });
    await vi.advanceTimersByTimeAsync(6_000);
    unsubscribe();
    expect(published.length).toBeGreaterThan(afterFirst);
  });
});
