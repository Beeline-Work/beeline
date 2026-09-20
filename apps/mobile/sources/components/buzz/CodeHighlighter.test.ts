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
    Pressable: host('Pressable'),
  };
});

vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => undefined) }));
vi.mock('./HullActionSheet', () => {
  const ReactModule = require('react');
  return {
    HULL_SHEET_INSET: 22,
    HullActionSheetModal: (props: any) =>
      ReactModule.createElement('HullActionSheetModal', props, props.children),
    HullActionSheetRow: (props: any) => ReactModule.createElement('HullActionSheetRow', props),
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
  return tokenizeCode(input, lang)
    .flat()
    .map((s) => s.token);
}

function tokenStrings(input: string, lang: string | null = 'typescript'): string[] {
  return tokenizeCode(input, lang)
    .flat()
    .map((s) => s.text);
}

describe('tokenizeCode', () => {
  it('keeps a long code block complete without one native span per plain character', () => {
    const code = Array.from(
      { length: 400 },
      (_, index) =>
        `export async function handler${index}(request: Request): Promise<Response> { return Response.json({ index: ${index}, path: request.url, ok: true }); }`,
    ).join('\n');
    const tokenized = tokenizeCode(code, 'typescript');
    const spanCount = tokenized.reduce((count, line) => count + line.length, 0);

    expect(flattenTokens(tokenized)).toBe(code);
    expect(spanCount).toBeLessThan(code.length / 2);
  });

  it('preserves full text through round-trip', () => {
    const code = `const x: number = 42;\n// a comment\nconsole.log("hello");`;
    expect(flattenTokens(tokenizeCode(code, 'typescript'))).toBe(code);
  });

  it('classifies keywords as names', () => {
    const tokens = tokensOf('const x = async () => {};');
    expect(tokens.filter((t) => t === 'name').length).toBeGreaterThanOrEqual(2);
    expect(tokens).toContain('name');
  });

  it('classifies string literals as values', () => {
    const strings = tokensOf('"hello"', null);
    expect(strings).toContain('value');
  });

  it('classifies single-quoted strings as values', () => {
    const tokens = tokenizeCode(`const s = 'hello';`, 'typescript').flat();
    const strTokens = tokens.filter((t) => t.token === 'value');
    expect(strTokens.some((t) => t.text.includes('hello'))).toBe(true);
  });

  it('classifies template literals as values', () => {
    const tokens = tokenizeCode('const s = `hello ${name}`;', 'typescript').flat();
    const strTokens = tokens.filter((t) => t.token === 'value');
    expect(strTokens.length).toBeGreaterThanOrEqual(1);
    expect(strTokens.some((t) => t.text.includes('hello'))).toBe(true);
  });

  it('classifies numbers as values', () => {
    const tokens = tokenizeCode('const n = 42;', 'typescript').flat();
    expect(tokens.some((t) => t.token === 'value' && t.text === '42')).toBe(true);
  });

  it('classifies hex numbers as values', () => {
    const tokens = tokenizeCode('const n = 0xff;', 'typescript').flat();
    expect(tokens.some((t) => t.token === 'value' && t.text === '0xff')).toBe(true);
  });

  it('classifies line comments as structure', () => {
    const tokens = tokenizeCode('// this is a comment\nconst x = 1;', 'typescript').flat();
    const commentTokens = tokens.filter((t) => t.token === 'structure');
    expect(commentTokens.some((t) => t.text.includes('comment'))).toBe(true);
  });

  it('classifies block comments as structure', () => {
    const tokens = tokenizeCode('/* block */ const x = 1;', 'typescript').flat();
    expect(tokens.some((t) => t.token === 'structure' && t.text.includes('block'))).toBe(true);
  });

  it('classifies python-style # comments as structure', () => {
    const tokens = tokenizeCode('# a comment\nx = 1', 'python').flat();
    expect(tokens.some((t) => t.token === 'structure' && t.text.includes('comment'))).toBe(true);
  });

  it('classifies built-in names as names', () => {
    const tokens = tokenizeCode('console.log("hello");', 'typescript').flat();
    expect(tokens.some((t) => t.token === 'name' && t.text === 'console')).toBe(true);
  });

  it('classifies function calls as names', () => {
    const tokens = tokenizeCode('foo();', 'typescript').flat();
    expect(tokens.some((t) => t.token === 'name' && t.text === 'foo')).toBe(true);
  });

  it('paints a JSON key and its value as different roles', () => {
    const tokens = tokenizeCode('{ "apiKey": "sk-or-..." }', 'json').flat();
    expect(flattenTokens(tokenizeCode('{ "apiKey": "sk-or-..." }', 'json'))).toBe(
      '{ "apiKey": "sk-or-..." }',
    );
    expect(tokens.some((t) => t.token === 'name' && t.text === '"apiKey"')).toBe(true);
    expect(tokens.some((t) => t.token === 'value' && t.text === '"sk-or-..."')).toBe(true);
    expect(tokens.some((t) => t.token === 'value' && t.text === '"apiKey"')).toBe(false);
  });

  it('honours JSON so true is a value, not a type name', () => {
    const tokens = tokenizeCode('{ "reasoning": true }', 'json').flat();
    expect(tokens.some((t) => t.token === 'value' && t.text === 'true')).toBe(true);
    expect(tokens.some((t) => t.token === 'name' && t.text === '"reasoning"')).toBe(true);
  });

  it('does not paint a URL as a comment in shell', () => {
    const code = 'curl https://usebeeline.app/dl/x.json';
    expect(flattenTokens(tokenizeCode(code, 'bash'))).toBe(code);
    const tokens = tokenizeCode(code, 'bash').flat();
    expect(tokens.some((t) => t.token === 'structure' && t.text.includes('usebeeline'))).toBe(
      false,
    );
  });

  it.each(['jsonc', 'json5', 'yaml', 'yml', 'css', 'html', 'python', 'bash', 'sql'])(
    'uses the generic scanner for %s',
    (language) => {
      const code = '{ "name": "Milo", "reasoning": true }\nconst x = 42; # note';
      expect(tokenizeCode(code, language)).toEqual(tokenizeCode(code, null));
      expect(flattenTokens(tokenizeCode(code, language))).toBe(code);
      expect(tokenizeCode(code, language)[0]).not.toEqual(tokenizeCode(code, 'json')[0]);
    },
  );

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
    expect(tokens.some((t) => t.token === 'value' && t.text.includes('hi'))).toBe(true);
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
  it('keeps a lengthy code block selectable and complete without thousands of native spans', () => {
    const code = Array.from(
      { length: 400 },
      (_, index) =>
        `export async function handler${index}(request: Request): Promise<Response> { return Response.json({ index: ${index}, path: request.url, ok: true }); }`,
    ).join('\n');
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(CodeHighlighter, { code, language: 'typescript' }));
    });

    expect(renderedText(renderer)).toBe(code);
    const textNodes = renderer.root.findAllByType('Text');
    expect(textNodes).toHaveLength(1);
    expect(textNodes[0]!.props.selectable).toBe(true);
  });

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

  it('keeps indented JSON leading spaces after tokenize and render', () => {
    const code = `{
  "providers": {
    "milo": {
      "name": "Milo"
    }
  }
}`;
    expect(flattenTokens(tokenizeCode(code, 'json'))).toBe(code);

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(CodeHighlighter, { code, language: 'json' }));
    });
    const text = renderedText(renderer);
    expect(text.replaceAll('\u00a0', ' ')).toBe(code);
    expect(text).toContain(`\u00a0\u00a0"providers"`);
    expect(text).toContain(`\u00a0\u00a0\u00a0\u00a0"milo"`);
    expect(text).toContain(`\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0"name"`);
  });
});

// ---------------------------------------------------------------------------
// Integrated test: MonoMarkdown renders code blocks via CodeHighlighter
// ---------------------------------------------------------------------------

import { MonoMarkdown } from './MonoMarkdown';

describe('MonoMarkdown code blocks (via CodeHighlighter)', () => {
  it('renders a short fenced block without an inscription', () => {
    const md = '```typescript\nconst x: number = 42;\n```';
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(MonoMarkdown, { markdown: md }));
    });
    const text = renderedText(renderer);
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
