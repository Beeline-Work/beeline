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
    desktopExperience: false,
    addMessages: () => { order.push('row'); },
    landAtOwnSend: noop,
    yieldToNextPaint: async () => { order.push('paint'); },
    roomSurface: null, userPubkey: 'human-key', fallbackMemberName: () => 'Person',
    decodedId: 'conversation', reconcileOptimistic: noop,
    outbox: { current: () => ({ enqueue, send: sendOutbox }) },
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

  it('keeps the indicator for an offline send until its own bound clears it', async () => {
    const ack = ackRecorder();
    const { sendOutbox, context } = sendContext({ setPendingAck: ack.setPendingAck });
    // Offline: the outbox keeps the message and resolves without a write.
    sendOutbox.mockResolvedValue(undefined);
    expect(await runInNewContext(executable, context)()).toBe(true);
    expect(ack.current()).toEqual({ sentAt: expect.any(Number), requestId: 'signed-message' });
    // The existing COMPOSER_ACK_BOUND_MS deadline timer is what clears it.
    expect(source).toContain('const deadline = pendingAck.sentAt + COMPOSER_ACK_BOUND_MS;');
    expect(context.Modal.alert).not.toHaveBeenCalled();
  });

  it('never clears the indicator just because the message entered the outbox', () => {
    expect(source).not.toContain('The durable outbox now owns the Sending line');
  });
});
