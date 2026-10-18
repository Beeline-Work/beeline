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

describe('Reproduction R1: corner requests use ordinary message delivery', () => {
  it.each([
    { label: 'DM', isDirectMessage: true, accessIssue: false },
    { label: 'repo-less Room', isDirectMessage: false, accessIssue: false },
    { label: 'Room with revoked repo access', isDirectMessage: false, accessIssue: true },
  ])('$label sends, persists and clears the submitted draft', async ({ isDirectMessage, accessIssue }) => {
    const text = '@ruby Open a corner for issue 4';
    const event = { id: 'signed-message', created_at: 123 };
    const transport = {
      composeMessage: vi.fn().mockResolvedValue(event),
      publishPreparedMessage: vi.fn().mockResolvedValue({}),
    };
    const enqueue = vi.fn();
    const attempted = vi.fn();
    const clear = vi.fn(() => { draft.value = ''; return true; });
    const draft = { value: text, captureMessage: () => clear };
    const prompt = vi.fn();
    const noop = () => undefined;
    const context = {
      composerDraft: draft, inputTextRef: { current: text }, replyTarget: null,
      pendingAttachmentsRef: { current: [] }, sendInFlightRef: { current: false },
      isArchived: false, isCorner: false, isDirectMessage,
      roomRepository: accessIssue ? 'owner/repo' : null,
      roomRepositoryResolved: !accessIssue, roomRepoAccessIssue: accessIssue,
      looksLikeCornerOpenIntent: () => true, setCornerOpenRepoPrompt: prompt,
      activeCommunityId: null, roomRepoCandidates: [], transport,
      resolveComposerMentions: () => ({ pubkeys: ['ruby-key'] }), roomParticipants: [],
      selectedMentionsRef: { current: [] }, captureUntaggedSend: () => noop,
      selectedMentionAgentPubkey: noop, selectedAgentMentionsRef: { current: [] },
      roomAgents: [{ pubkey: 'ruby-key' }], mentionedAgentPubkey: () => 'ruby-key',
      setReceivedSteer: noop, setTagMenuOpen: noop, setPendingAck: noop, setSending: noop,
      desktopExperience: false, addMessages: noop, landAtOwnSend: noop,
      roomSurface: null, userPubkey: 'human-key', fallbackMemberName: () => 'Person',
      decodedId: 'conversation', reconcileOptimistic: noop,
      outbox: { current: () => ({ enqueue, attempted }) },
      activeComposerDraftRef: { current: draft }, composerInputRevisionRef: { current: 0 },
      composerRef: { current: { clear: noop } }, setComposerInputRevision: noop,
      setComposerHeight: noop, COMPOSER_MIN_HEIGHT: 40, setInputSelection: noop,
      replacePendingAttachments: noop, setReplyTarget: noop, acknowledgeReadMark: noop,
      Modal: { alert: vi.fn() }, console,
    };
    const send = runInNewContext(executable, context);
    expect(await send()).toBe(true);
    expect(transport.composeMessage).toHaveBeenCalledWith(
      { sessionId: 'conversation', text, attachments: [] },
      { mentionAgent: 'ruby-key', mentionPubkeys: ['ruby-key'] },
    );
    expect(enqueue).toHaveBeenCalledWith(event, expect.objectContaining({ text }));
    expect(attempted).toHaveBeenCalledWith(event.id);
    expect(transport.publishPreparedMessage).toHaveBeenCalledWith(event);
    expect(clear).toHaveBeenCalledOnce();
    expect(draft.value).toBe('');
    expect(context.Modal.alert).not.toHaveBeenCalled();
    if (isDirectMessage) expect(prompt).not.toHaveBeenCalled();
  });
});
