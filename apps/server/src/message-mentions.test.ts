import { describe, expect, it } from 'vitest';
import { typedMentionHandles } from './message-mentions.js';

describe('typedMentionHandles', () => {
  it('does not turn forwarded quote text into a fresh mention', () => {
    expect(typedMentionHandles('> @bee already answered\n\nFORWARDED FROM #general')).toEqual(
      new Set(),
    );
    expect(typedMentionHandles('> old line\n@bee take a look')).toEqual(new Set(['bee']));
  });
});
