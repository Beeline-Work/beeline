import { describe, expect, it } from 'vitest';
import { CodexPromptDelivery } from './codex-prompt-delivery.js';
import { assembleTurnPrompt, type TurnPromptContext } from './prompt-assembly.js';

const context: TurnPromptContext = {
  surface: 'room', sessionPrefix: 'Session rules', members: 'Members: @bee',
  memory: 'Memory: use Beeline',
  corners: [{ cornerId: 'corner', parentRoomId: 'room', createdBy: 'bee', archived: false }],
  transcript: { lines: ['Owner: hello'], sinceLastTurn: true },
  task: { body: 'Reply to me' },
};
const render = (delivery: CodexPromptDelivery, change: Partial<TurnPromptContext> = {}) =>
  assembleTurnPrompt({ ...context, ...change, delivery });

describe('Codex session block delivery', () => {
  it('sends every block on a cache miss and commits only successful deliveries', () => {
    const delivery = new CodexPromptDelivery();
    expect(render(delivery)).toEqual(assembleTurnPrompt(context));
    delivery.complete(false);
    expect(render(delivery)).toEqual(assembleTurnPrompt(context));
  });

  it('delivers rules once through session/new and other blocks on the first turn', () => {
    const delivery = new CodexPromptDelivery(context.sessionPrefix);
    const first = render(delivery);
    expect(first.text).not.toContain('Session rules');
    expect(first.text).toContain('Members: @bee');
    expect(first.text).toContain('Memory: use Beeline');
    expect(first.text).toContain('corner');
    delivery.complete(true);
    const warm = render(delivery);
    expect(warm.report.map(s => s.id)).toEqual(['turn.transcript', 'turn.task']);
    expect(warm.text).toContain('Owner: hello');
    expect(warm.text).toContain('Reply to me');
  });

  it('sends only the changed block plus the task and unchanged transcript', () => {
    const delivery = new CodexPromptDelivery();
    render(delivery); delivery.complete(true);
    expect(render(delivery, { memory: 'Memory: new preference' }).report.map(s => s.id))
      .toEqual(['turn.transcript', 'turn.memory', 'turn.task']);
  });

  it('restores every block after compaction, including one during a prompt', () => {
    const delivery = new CodexPromptDelivery(context.sessionPrefix);
    render(delivery); delivery.complete(true);
    render(delivery); delivery.invalidate(); delivery.complete(true);
    expect(render(delivery)).toEqual(assembleTurnPrompt(context));
    delivery.complete(true);
    expect(render(delivery).text).not.toContain('Session rules');
  });

  it('clears blocks that become empty, then caches the removal', () => {
    const delivery = new CodexPromptDelivery();
    render(delivery); delivery.complete(true);
    expect(render(delivery, { memory: '', corners: [] }).text)
      .toContain('turn.memory: now empty; replaces the previous block.');
    delivery.complete(true);
    expect(render(delivery, { memory: '', corners: [] }).report.map(s => s.id))
      .toEqual(['turn.transcript', 'turn.task']);
  });

});
