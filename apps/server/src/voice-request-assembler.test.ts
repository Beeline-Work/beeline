import { expect, it, vi } from 'vitest';
import { VoiceRequestAssembler, voiceNameOnly } from './voice-request-assembler.js';

const ruby = { id: 'ruby', name: 'Ruby', handle: 'ruby', voice: 'luna', soul: '' };
const goose = { ...ruby, id: 'goose', name: 'Goosey', handle: 'goose' };

it('expires names and taps after three seconds, renews only the speaking human, and replaces explicit targets', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const assembler = new VoiceRequestAssembler();
  try {
    assembler.address('alex', ruby.id);
    assembler.address('sam', goose.id);
    await vi.advanceTimersByTimeAsync(2000);
    assembler.speaking('alex');
    expect(assembler.target('alex')).toBe(ruby.id);
    await vi.advanceTimersByTimeAsync(1001);
    expect(assembler.target('sam')).toBeUndefined();
    expect(assembler.target('alex')).toBe(ruby.id);
    assembler.address('alex', goose.id);
    expect(assembler.target('alex')).toBe(goose.id);
    await vi.advanceTimersByTimeAsync(3000);
    expect(assembler.target('alex')).toBeUndefined();
    expect(assembler.current('alex')).toBeUndefined();
  } finally { assembler.close(); vi.useRealTimers(); }
});

it('revises only the same human until the playback boundary, then gives an audible follow-up a new ID', () => {
  const assembler = new VoiceRequestAssembler();
  const first = assembler.begin('alex', 'Ruby check').request;
  first.agent = ruby; first.state = 'classifying';
  const other = assembler.begin('sam', 'Goosey help').request;
  expect(first.classification.signal.aborted).toBe(false);
  const revised = assembler.begin('alex', 'my latest report').request;
  expect(revised.id).toBe(first.id);
  expect(revised.agent).toBe(ruby);
  expect(revised.text).toBe('Ruby check my latest report');
  expect(first.classification.signal.aborted).toBe(true);
  expect(other.classification.signal.aborted).toBe(false);
  revised.state = 'replying';
  const merged = assembler.begin('alex', 'with seconds').request;
  expect(merged.id).toBe(first.id);
  expect(merged.text).toBe('Ruby check my latest report with seconds');
  assembler.finish('alex', merged);
  const next = assembler.begin('alex', 'Ruby next request').request;
  expect(next.id).not.toBe(first.id);
  assembler.finish('alex', revised);
  expect(assembler.current('alex')).toBe(next);
  assembler.cancel('alex');
  expect(next.classification.signal.aborted).toBe(true);
  expect(assembler.current('alex')).toBeUndefined();
  assembler.close();
});

it('recognizes a name-only segment without mistaking a request for one', () => {
  expect(voiceNameOnly('Hey Ruby!', [ruby, goose])).toBe(ruby);
  expect(voiceNameOnly('Ruby check my latest report', [ruby, goose])).toBeUndefined();
  expect(voiceNameOnly('Ruby help', [{...ruby, name: 'Ruby Red'}])).toBeUndefined();
  expect(voiceNameOnly('Ruby Red', [{...ruby, name: 'Ruby Red'}])?.id).toBe('ruby');
});

it('retains a failed delivery even when a later request finishes first', () => {
  const assembler = new VoiceRequestAssembler();
  const first = assembler.begin('alex', 'Ruby build it').request;
  first.state = 'delivering';
  assembler.cancel('alex');
  const next = assembler.begin('alex', 'Goosey help').request;
  assembler.retainFailure('alex', first);
  expect(assembler.retryable('alex')).toBeUndefined();
  assembler.finish('alex', next);
  expect(assembler.retryable('alex')?.id).toBe(first.id);
  assembler.finish('alex', first);
  expect(assembler.retryable('alex')).toBeUndefined();
  assembler.close();
});
