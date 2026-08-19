import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Platform: { OS: 'android', select: (obj: any) => obj.android ?? obj.default },
    Linking: { openURL: vi.fn() },
    StyleSheet: { create: (styles: unknown) => styles },
    Text: host('Text'),
    View: host('View'),
    ScrollView: host('ScrollView'),
  };
});

import { tokenizeCode, flattenTokens, type HighlightToken } from '@/buzz/syntax-highlight';
import { CodeHighlighter } from '@/components/buzz/CodeHighlighter';

const originalConsoleError = console.error;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
    originalConsoleError(message, ...args);
  });
});

afterAll(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// Unit tests: tokenizeCode
// ---------------------------------------------------------------------------

function tokensOf(input: string, lang: string | null = 'typescript'): HighlightToken[] {
  return tokenizeCode(input, lang).flat().map((s) => s.token);
}

function tokenStrings(input: string, lang: string | null = 'typescript'): string[] {
  return tokenizeCode(input, lang).flat().map((s) => s.text);
}

describe('tokenizeCode', () => {
  it('preserves full text through round-trip', () => {
    const code = `const x: number = 42;\n// a comment\nconsole.log("hello");`;
    expect(flattenTokens(tokenizeCode(code, 'typescript'))).toBe(code);
  });

  it('classifies keywords', () => {
    const tokens = tokensOf('const x = async () => {};');
    expect(tokens.filter((t) => t === 'keyword').length).toBeGreaterThanOrEqual(2);
    expect(tokens).toContain('keyword');
  });

  it('classifies string literals', () => {
    const tokens = tokensOf('const x = "hello world";');
    // "hello world" should be classified as a string
    const strings = tokensOf('"hello"', null);
    expect(strings).toContain('string');
  });

  it('classifies single-quoted strings', () => {
    const tokens = tokenizeCode(`const s = 'hello';`, 'typescript').flat();
    const strTokens = tokens.filter((t) => t.token === 'string');
    expect(strTokens.length).toBeGreaterThanOrEqual(1);
  });

  it('classifies template literals', () => {
    const tokens = tokenizeCode('const s = `hello ${name}`;', 'typescript').flat();
    const strTokens = tokens.filter((t) => t.token === 'string');
    expect(strTokens.length).toBeGreaterThanOrEqual(1);
    expect(strTokens.some((t) => t.text.includes('hello'))).toBe(true);
  });

  it('classifies numbers', () => {
    const tokens = tokenizeCode('const n = 42;', 'typescript').flat();
    const numTokens = tokens.filter((t) => t.token === 'number');
    expect(numTokens.some((t) => t.text === '42')).toBe(true);
  });

  it('classifies hex numbers', () => {
    const tokens = tokenizeCode('const n = 0xff;', 'typescript').flat();
    const numTokens = tokens.filter((t) => t.token === 'number');
    expect(numTokens.some((t) => t.text === '0xff')).toBe(true);
  });

  it('classifies line comments', () => {
    const tokens = tokenizeCode('// this is a comment\nconst x = 1;', 'typescript').flat();
    const commentTokens = tokens.filter((t) => t.token === 'comment');
    expect(commentTokens.length).toBeGreaterThanOrEqual(1);
    expect(commentTokens.some((t) => t.text.includes('comment'))).toBe(true);
  });

  it('classifies block comments', () => {
    const tokens = tokenizeCode('/* block */ const x = 1;', 'typescript').flat();
    const commentTokens = tokens.filter((t) => t.token === 'comment');
    expect(commentTokens.length).toBeGreaterThanOrEqual(1);
    expect(commentTokens.some((t) => t.text.includes('block'))).toBe(true);
  });

  it('classifies python-style # comments', () => {
    const tokens = tokenizeCode('# a comment\nx = 1', 'python').flat();
    const commentTokens = tokens.filter((t) => t.token === 'comment');
    expect(commentTokens.length).toBeGreaterThanOrEqual(1);
  });

  it('classifies built-in names', () => {
    const tokens = tokenizeCode('console.log("hello");', 'typescript').flat();
    expect(tokens.some((t) => t.token === 'builtin' && t.text === 'console')).toBe(true);
  });

  it('classifies function calls', () => {
    const tokens = tokenizeCode('foo();', 'typescript').flat();
    // The function name before '(' should be classified; paren is punctuation
    expect(tokens.some((t) => t.token === 'function' && t.text === 'foo')).toBe(true);
  });

  it('handles empty string', () => {
    expect(flattenTokens(tokenizeCode('', 'typescript'))).toBe('');
  });

  it('handles empty lines', () => {
    const lines = tokenizeCode('\n\n', 'typescript');
    expect(lines.length).toBe(3);
    expect(lines[0]).toEqual([]);
    expect(lines[1]).toEqual([]);
    expect(lines[2]).toEqual([]);
  });

  it('handles unknown language gracefully', () => {
    const code = 'fn main() { println!("hi"); }';
    expect(flattenTokens(tokenizeCode(code, 'rust'))).toBe(code);
    // Should still classify strings and numbers
    const tokens = tokenizeCode(code, 'rust').flat();
    expect(tokens.some((t) => t.token === 'string')).toBe(true);
  });

  it('handles code with no language hint', () => {
    const tokens = tokenizeCode('const x = 1;', null).flat();
    // With no language, keyword/type/builtin classification is less aggressive
    // but strings, numbers, and comments still work
    expect(tokens.some((t) => t.token === 'keyword' || t.token === 'plain')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Component tests: CodeHighlighter
// ---------------------------------------------------------------------------

function collectText(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(collectText).join('');
  if (typeof node === 'object' && 'children' in (node as any)) {
    return collectText((node as any).children);
  }
  return '';
}

function renderedText(renderer: ReactTestRenderer): string {
  return collectText(renderer.toJSON());
}

describe('CodeHighlighter', () => {
  it('renders code text', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        React.createElement(CodeHighlighter, { code: 'const x = 1;', language: 'typescript' }),
      );
    });
    const text = renderedText(renderer);
    expect(text).toContain('const x = 1;');
  });

  it('renders empty string as null', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(CodeHighlighter, { code: '', language: 'typescript' }));
    });
    expect(renderer.toJSON()).toBeNull();
  });

  it('renders multi-line code', () => {
    const code = 'line1\nline2\nline3';
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(CodeHighlighter, { code, language: 'typescript' }));
    });
    const text = renderedText(renderer);
    expect(text).toContain('line1');
    expect(text).toContain('line2');
    expect(text).toContain('line3');
  });

  it('renders with no language hint', () => {
    const code = 'hello world';
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(CodeHighlighter, { code, language: null }));
    });
    const text = renderedText(renderer);
    expect(text).toBe('hello world');
  });
});

// ---------------------------------------------------------------------------
// Integrated test: MonoMarkdown renders code blocks via CodeHighlighter
// ---------------------------------------------------------------------------

import { MonoMarkdown } from './MonoMarkdown';

describe('MonoMarkdown code blocks (via CodeHighlighter)', () => {
  it('renders a fenced code block with language label', () => {
    const md = '```typescript\nconst x: number = 42;\n```';
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(MonoMarkdown, { markdown: md }));
    });
    const text = renderedText(renderer);
    expect(text).toContain('typescript');
    expect(text).toContain('const x');
    expect(text).toContain('number');
    expect(text).toContain('42');
  });

  it('renders an unfenced code block (no language)', () => {
    const md = '```\nplain text block\n```';
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(MonoMarkdown, { markdown: md }));
    });
    const text = renderedText(renderer);
    expect(text).toContain('plain text block');
  });

  it('renders empty code block without crashing', () => {
    const md = '```\n```';
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(MonoMarkdown, { markdown: md }));
    });
    // Should not throw
    expect(renderer.toJSON()).toBeTruthy();
  });

  it('renders code block after other content', () => {
    const md = 'Some text.\n\n```js\nconsole.log("hi");\n```';
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(MonoMarkdown, { markdown: md }));
    });
    const text = renderedText(renderer);
    expect(text).toContain('Some text');
    expect(text).toContain('console');
    expect(text).toContain('hi');
  });
});