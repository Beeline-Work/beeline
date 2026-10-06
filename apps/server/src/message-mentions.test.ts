import { describe, expect, it } from 'vitest';
import { hasChannelMention, isChannelMentionToken, typedMentionHandles } from './message-mentions.js';

describe('typedMentionHandles', () => {
  it('does not turn forwarded quote text into a fresh mention', () => {
    expect(typedMentionHandles('> @bee already answered\n\nFORWARDED FROM #general')).toEqual(
      new Set(),
    );
    expect(typedMentionHandles('> old line\n@bee take a look')).toEqual(new Set(['bee']));
  });

  it('does not read the author credited in a forward caption as a mention', () => {
    expect(typedMentionHandles('> ship it\n\nFORWARDED FROM #general · @bee')).toEqual(new Set());
    expect(typedMentionHandles('@ada see this\n\nFORWARDED FROM #general · @bee')).toEqual(
      new Set(['ada']),
    );
  });

  it('skips handles inside inline code spans and fenced code blocks', () => {
    expect(typedMentionHandles('The probe reads `@goosy and @hoots take it`.')).toEqual(new Set());
    expect(typedMentionHandles('Probe:\n```ts\nsend("@goosy fix it");\n```\nDone.')).toEqual(
      new Set(),
    );
    expect(typedMentionHandles('```\n@goosy never closed\n@hoots')).toEqual(new Set());
  });

  it('reads a handle in prose next to code', () => {
    expect(typedMentionHandles('@candy see `@goosy` in the probe')).toEqual(new Set(['candy']));
    expect(typedMentionHandles('```\n@goosy\n```\n@candy fix R1')).toEqual(new Set(['candy']));
    expect(typedMentionHandles('Run `npm test`, then @candy merge')).toEqual(new Set(['candy']));
  });

  it('keeps reading mentions after an unclosed backtick', () => {
    expect(typedMentionHandles('a stray ` backtick, @candy take it')).toEqual(new Set(['candy']));
    expect(typedMentionHandles('stray `\n@candy take it')).toEqual(new Set(['candy']));
  });

  it('reads a literal @channel token through the same tokenizer path as a handle', () => {
    expect(typedMentionHandles('@channel please review')).toEqual(new Set(['channel']));
  });
});

describe('isChannelMentionToken', () => {
  it('matches the reserved token case-insensitively', () => {
    expect(isChannelMentionToken('channel')).toBe(true);
    expect(isChannelMentionToken('Channel')).toBe(true);
    expect(isChannelMentionToken('CHANNEL')).toBe(true);
    expect(isChannelMentionToken(' channel ')).toBe(true);
  });

  it('does not match an ordinary handle', () => {
    expect(isChannelMentionToken('ada')).toBe(false);
    expect(isChannelMentionToken('channels')).toBe(false);
    expect(isChannelMentionToken('the-channel')).toBe(false);
  });
});

describe('hasChannelMention', () => {
  it('is true only when a live @channel token is written', () => {
    expect(hasChannelMention('@channel heads up')).toBe(true);
    expect(hasChannelMention('@Channel heads up')).toBe(true);
    expect(hasChannelMention('please check the #channel')).toBe(false);
    expect(hasChannelMention('@ada please review')).toBe(false);
  });

  it('ignores @channel written inside a quoted/forwarded line, like any other mention', () => {
    expect(hasChannelMention('> @channel already answered\n\nFORWARDED FROM #general')).toBe(
      false,
    );
  });
});
