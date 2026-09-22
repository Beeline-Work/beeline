import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const codeBlock = readFileSync(
  new URL('../../../../components/buzz/CodeBlock.tsx', import.meta.url),
  'utf8',
);
const markdown = readFileSync(
  new URL('../../../../components/buzz/MonoMarkdown.tsx', import.meta.url),
  'utf8',
);
const chat = readFileSync(new URL('./_chat-surface.tsx', import.meta.url), 'utf8');
const layout = readFileSync(new URL('../../_layout.tsx', import.meta.url), 'utf8');
const reader = readFileSync(new URL('../../code-reader.tsx', import.meta.url), 'utf8');

describe('long code reader navigation', () => {
  it('opens a declared full-page route instead of an in-message sheet', () => {
    expect(layout).toContain('name="code-reader"');
    expect(codeBlock).toContain("pathname: '/code-reader'");
    expect(codeBlock).not.toContain('ToolOutputSheet');
    expect(reader).toContain('testID="code-reader"');
    expect(reader).toContain('<ScrollView');
    expect(reader).toContain('<CodeHighlighter code={code}');
  });

  it('carries the owning message through markdown and re-centers it when Back restores chat', () => {
    expect(markdown).toContain('originMessageId={codeOriginMessageId}');
    expect(codeBlock).toContain('...(originMessageId ? { originMessageId } : {})');
    expect(chat).toContain('codeReaderReturnMessageIdRef.current = originMessageId');
    expect(chat).toMatch(
      /useFocusEffect\([\s\S]*codeReaderReturnMessageIdRef\.current[\s\S]*message\.relayId === messageId[\s\S]*viewPosition: 0\.5/,
    );
  });
});
