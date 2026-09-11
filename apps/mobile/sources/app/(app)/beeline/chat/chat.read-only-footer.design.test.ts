import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./[channelId].tsx', import.meta.url), 'utf8');

describe('Chat read-only footer', () => {
  it('sits above Android system navigation', () => {
    expect(source).toContain("Platform.OS === 'android'");
    expect(source).toContain('{ marginBottom: insets.bottom }');
    expect(source.match(/styles\.archivedInputBar, readOnlyFooterInset/g)).toHaveLength(2);
  });
});
