import { describe, expect, it } from 'vitest';
import { assembleTurnPrompt } from './prompt-assembly.js';

const message = (id: string, body: string) => `[message id: ${id}]\nMember: ${body}`;

describe('turn transcript budget', () => {
  it('keeps recent conversation and leaves room for a small model to answer', () => {
    const lines = Array.from({ length: 80 }, (_, index) =>
      message(`row-${index}`, 'x'.repeat(4_000)),
    );
    const prompt = assembleTurnPrompt({
      surface: 'room',
      modelContextTokens: 16_000,
      sessionPrefix: 'rules'.repeat(1_000),
      transcript: { lines, sinceLastTurn: false },
      task: { body: 'answer this request' },
    }).text;
    expect(Buffer.byteLength(prompt)).toBeLessThan(20_000);
    expect(prompt).toContain('row-79');
    expect(prompt).toContain('answer this request');
  });

  it('truncates one oversized row with a stable message fetch pointer', () => {
    const prompt = assembleTurnPrompt({
      surface: 'room',
      modelContextTokens: 32_000,
      transcript: { lines: [message('large-row', 'z'.repeat(250_000))], sinceLastTurn: false },
      task: { body: 'reply' },
    }).text;
    expect(Buffer.byteLength(prompt)).toBeLessThan(10_000);
    expect(prompt).toContain('get_room_message');
    expect(prompt).toContain('large-row');
  });

  it('bounds an oversized initiating Room message as well', () => {
    const prompt = assembleTurnPrompt({
      surface: 'room',
      modelContextTokens: 16_000,
      task: { body: `[message id: task-row]\n${'A'.repeat(100_000)}` },
    }).text;
    expect(Buffer.byteLength(prompt)).toBeLessThan(5_000);
    expect(prompt).toContain('get_room_message with messageId "task-row"');
  });

  it('retains ordinary conversation', () => {
    const line = message('ordinary', 'A normal discussion.');
    const prompt = assembleTurnPrompt({
      surface: 'room',
      modelContextTokens: 32_000,
      transcript: { lines: [line], sinceLastTurn: false },
      task: { body: 'reply' },
    }).text;
    expect(prompt).toContain(line);
  });

  it('omits inline image and attachment payloads but retains a fetch pointer', () => {
    const data = 'Ab3/'.repeat(2_000);
    const prompt = assembleTurnPrompt({
      surface: 'room',
      modelContextTokens: 32_000,
      transcript: {
        lines: [
          message('media-row', `Look at ![](data:image/png;base64,${data}) and file ${data}`),
        ],
        sinceLastTurn: false,
      },
      task: { body: 'reply' },
    }).text;
    expect(prompt).not.toContain(data);
    expect(prompt).not.toContain('data:image/png;base64,');
    expect(prompt).toContain('get_room_message');
    expect(prompt).toContain('media-row');
  });
});
