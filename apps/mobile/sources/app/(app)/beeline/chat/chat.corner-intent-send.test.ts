import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// Execute the real send callback without mounting the screen's native providers.
const source = readFileSync(new URL('./_chat-surface.tsx', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('chat.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback = '';
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === 'handleSend') {
    callback = (node.initializer as ts.CallExpression).arguments[0].getText(parsed);
  }
  ts.forEachChild(node, visit);
}
visit(parsed);
const executable = ts.transpileModule(`(${callback})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function sendContext(overrides: Record<string, unknown> = {}) {
  const text = '@ruby Open a corner for issue 4';
  const event = { id: 'signed-message', created_at: 123 };
  const order: string[] = [];
  const transport = {
    composeMessage: vi.fn(async () => { order.push('compose'); return event; }),
    publishPreparedMessage: vi.fn(async () => { order.push('publish'); return {}; }),
  };
  const enqueue = vi.fn();
  const sendOutbox = vi.fn(async () => transport.publishPreparedMessage(event));
  const clear = vi.fn(() => { draft.value = ''; return true; });
  const draft = { value: text, captureMessage: () => clear };
  const prompt = vi.fn();
  const noop = () => undefined;
  const context = {
    prepareRouterMessageGesture: () => undefined,
    composerDraft: draft, inputTextRef: { current: text }, replyTarget: null,
    pendingAttachmentsRef: { current: [] }, sendInFlightRef: { current: false },
    isArchived: false, isCorner: false, isDirectMessage: false,
    roomRepository: null, roomRepositoryResolved: true, roomRepoAccessIssue: false,
    looksLikeCornerOpenIntent: () => true, setCornerOpenRepoPrompt: prompt,
    activeCommunityId: null, roomRepoCandidates: [], transport,
    resolveComposerMentions: () => ({ pubkeys: ['ruby-key'] }), roomParticipants: [],
    selectedMentionsRef: { current: [] }, captureUntaggedSend: () => noop,
    selectedMentionAgentPubkey: noop, selectedAgentMentionsRef: { current: [] },
    roomAgents: [{ pubkey: 'ruby-key' }], mentionedAgentPubkey: () => 'ruby-key',
    setReceivedSteer: noop, setTagMenuOpen: noop, setPendingAck: noop, setSending: noop,
    desktopExperience: false, desktopTranscript: false,
    sendPreview: { show: async () => { order.push('row'); order.push('paint'); }, reconcile: noop, remove: noop },
    scrollController: { request: noop }, removeOptimistic: noop,
    addMessages: () => { order.push('row'); },
    landAtOwnSend: noop,
    yieldToNextPaint: async () => { order.push('paint'); },
    roomSurface: null, userPubkey: 'human-key', fallbackMemberName: () => 'Person',
    decodedId: 'conversation', reconcileOptimistic: noop,
    outbox: { current: () => ({ enqueue, send: sendOutbox, get: () => ({}) }) },
    isFocused: () => false,
    activeComposerDraftRef: { current: draft }, composerInputRevisionRef: { current: 0 },
    composerRef: { current: { clear: noop } }, setComposerInputRevision: noop,
    setComposerHeight: noop, COMPOSER_MIN_HEIGHT: 40, setInputSelection: noop,
    replacePendingAttachments: noop, setReplyTarget: noop, acknowledgeReadMark: noop,
    Modal: { alert: vi.fn() }, console,
    ...overrides,
  };
  return { text, event, order, transport, enqueue, sendOutbox, clear, draft, prompt, context };
}

describe('Reproduction R1: corner requests use ordinary message delivery', () => {
  it.each([
    { label: 'DM', isDirectMessage: true, accessIssue: false },
    { label: 'repo-less Room', isDirectMessage: false, accessIssue: false },
    { label: 'Room with revoked repo access', isDirectMessage: false, accessIssue: true },
  ])('$label sends, persists and clears the submitted draft', async ({ isDirectMessage, accessIssue }) => {
    const { text, event, order, transport, enqueue, sendOutbox, clear, draft, prompt, context } = sendContext({
      isDirectMessage,
      roomRepository: accessIssue ? 'owner/repo' : null,
      roomRepositoryResolved: !accessIssue, roomRepoAccessIssue: accessIssue,
    });
    const send = runInNewContext(executable, context);
    expect(await send()).toBe(true);
    expect(order).toEqual(['row', 'paint', 'compose', 'publish']);
    expect(transport.composeMessage).toHaveBeenCalledWith(
      { sessionId: 'conversation', text, attachments: [] },
      { mentionAgent: 'ruby-key', mentionPubkeys: ['ruby-key'] },
    );
    expect(enqueue).toHaveBeenCalledWith(event, expect.objectContaining({ text }));
    expect(sendOutbox).toHaveBeenCalledWith(event.id);
    expect(transport.publishPreparedMessage).toHaveBeenCalledWith(event);
    expect(clear).toHaveBeenCalledOnce();
    expect(draft.value).toBe('');
    expect(context.Modal.alert).not.toHaveBeenCalled();
    if (isDirectMessage) expect(prompt).not.toHaveBeenCalled();
  });
});

it('SEND-LIST-2: only the local row runs before native paint; duplicate taps cannot start another send', async () => {
  let paint!: () => void;
  const show = vi.fn(() => new Promise<void>(resolve => { paint = resolve; }));
  const status = vi.fn(), land = vi.fn();
  const { context, transport, prompt } = sendContext({
    sendPreview: { show, reconcile: vi.fn(), remove: vi.fn() },
    setSending: status, setPendingAck: status, landAtOwnSend: land,
  });
  const send = runInNewContext(executable, context);
  const pending = send();
  expect(show).toHaveBeenCalledOnce();
  expect(status).not.toHaveBeenCalled();
  expect(prompt).not.toHaveBeenCalled();
  expect(land).not.toHaveBeenCalled();
  expect(transport.composeMessage).not.toHaveBeenCalled();
  expect(await send()).toBeUndefined();
  expect(show).toHaveBeenCalledOnce();
  paint();
  expect(await pending).toBe(true);
  expect(land).toHaveBeenCalled();
  expect(status).toHaveBeenCalled();
  expect(prompt).toHaveBeenCalled();
});

it('removes a preview when durable enqueue fails and keeps the submitted draft for retry', async () => {
  const remove = vi.fn();
  const enqueue = vi.fn(async () => { throw new Error('storage unavailable'); });
  const { context, draft, text } = sendContext({
    sendPreview: { show: async () => undefined, reconcile: vi.fn(), remove },
    outbox: { current: () => ({ enqueue, get: () => undefined }) },
    console: { warn: vi.fn() },
  });
  expect(await runInNewContext(executable, context)()).toBe(false);
  expect(remove).toHaveBeenCalledWith('signed-message');
  expect(draft.value).toBe(text);
  expect(context.sendInFlightRef.current).toBe(false);
});

describe('Reproduction R3: a send addressed to an agent shows the thinking indicator, not a Sending line', () => {
  // Replays the composer's pendingAck state the way React would.
  function ackRecorder() {
    let ack: { sentAt: number; requestId?: string } | null = null;
    const setPendingAck = vi.fn((next: typeof ack | ((current: typeof ack) => typeof ack)) => {
      ack = typeof next === 'function' ? next(ack) : next;
    });
    return { setPendingAck, current: () => ack };
  }

  it('keeps the indicator through the round trip and retires it on the server ack', async () => {
    const ack = ackRecorder();
    let acked!: (value: object) => void;
    const { sendOutbox, context } = sendContext({ setPendingAck: ack.setPendingAck });
    sendOutbox.mockImplementation(() => new Promise((resolve) => { acked = resolve; }));
    const sent = runInNewContext(executable, context)();
    await vi.waitFor(() => expect(sendOutbox).toHaveBeenCalledOnce());
    // The row is in the transcript and the server has not answered yet.
    expect(ack.current()).toEqual({ sentAt: expect.any(Number), requestId: 'signed-message' });
    acked({});
    expect(await sent).toBe(true);
    expect(ack.current()).toBeNull();
  });

  it('keeps the indicator when enqueue succeeds but the offline outbox has no server ack', async () => {
    const ack = ackRecorder();
    const { enqueue, event, sendOutbox, context, draft } = sendContext({ setPendingAck: ack.setPendingAck });
    enqueue.mockImplementation(() => {
      expect(ack.current()).toEqual({ sentAt: expect.any(Number), requestId: event.id });
    });
    // Offline: the outbox keeps the message and resolves without a write.
    sendOutbox.mockResolvedValue(undefined);
    expect(await runInNewContext(executable, context)()).toBe(true);
    expect(enqueue).toHaveBeenCalledWith(event, expect.objectContaining({ text: '@ruby Open a corner for issue 4' }));
    expect(sendOutbox).toHaveBeenCalledWith(event.id);
    expect(draft.value).toBe('');
    expect(ack.current()).toEqual({ sentAt: expect.any(Number), requestId: 'signed-message' });
    expect(context.Modal.alert).not.toHaveBeenCalled();
  });
});


it('finishes a first-paint send in its captured source outbox after navigation', async () => {
  let paint!: () => void;
  const fixture = sendContext({
    sendPreview: { show: () => new Promise<void>(resolve => { paint = resolve; }),
      reconcile: vi.fn(), remove: vi.fn() },
  });
  const original = fixture.context.outbox.current();
  let active: typeof original | null = original;
  fixture.context.outbox.current = () => active as typeof original;
  const pending = runInNewContext(executable, fixture.context)();
  active = null; // Session cleanup after changing the route's Room.
  paint();
  expect(await pending).toBe(true);
  expect(fixture.transport.composeMessage).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: 'conversation' }), expect.anything());
  expect(fixture.enqueue).toHaveBeenCalledWith(fixture.event, expect.objectContaining({ text: fixture.text }));
  expect(fixture.sendOutbox).toHaveBeenCalledWith(fixture.event.id);
});
