/**
 * Lightweight, zero-dependency syntax tokenizer for React Native.
 *
 * DESIGN: keyword/type/builtin words are matched as literal word-boundary
 * patterns so they never get merged into a plain-text run.  The function-call
 * pattern (ident followed by `(`) is checked AFTER those, so `async ()`
 * emits `name async` + `structure (` not a call named `async`.
 */

import type { SyntaxRole } from '@/buzz/syntax-colors';

export type HighlightToken = SyntaxRole | 'plain';

type TokenSpan = { token: HighlightToken; text: string };

type ScanToken =
  | 'keyword'
  | 'string'
  | 'number'
  | 'comment'
  | 'type'
  | 'builtin'
  | 'punctuation'
  | 'function'
  | 'tag'
  | 'attrName'
  | 'attrValue'
  | 'plain';

type ScanSpan = { token: ScanToken; text: string };

const JS_KEYWORDS = new Set([
  'abstract', 'arguments', 'as', 'assert', 'async', 'await', 'break', 'case',
  'catch', 'class', 'const', 'continue', 'debugger', 'declare', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'extern', 'finally',
  'for', 'from', 'function', 'get', 'if', 'implements', 'import', 'in',
  'instanceof', 'interface', 'is', 'let', 'module', 'namespace', 'new',
  'of', 'package', 'private', 'protected', 'public', 'readonly', 'require',
  'return', 'set', 'static', 'super', 'switch', 'this', 'throw', 'try',
  'type', 'typeof', 'undefined', 'use', 'var', 'void', 'while', 'with',
  'yield',
]);

const TYPES = new Set([
  'string', 'number', 'boolean', 'symbol', 'any', 'never', 'unknown',
  'void', 'undefined', 'null', 'bigint', 'object', 'true', 'false',
  'int', 'float', 'double', 'char', 'byte', 'short', 'long',
  'bool', 'i8', 'i16', 'i32', 'i64', 'u8', 'u16', 'u32', 'u64',
  'f32', 'f64', 'str', 'String', 'Number', 'Boolean', 'Array',
  'Record', 'Partial', 'Required', 'Pick', 'Omit', 'Promise',
  'Optional', 'Set', 'Map', 'Error', 'Date', 'RegExp',
  'PromiseLike', 'Iterable', 'Iterator', 'Maybe', 'Either',
]);

const VALUE_LITERALS = new Set(['true', 'false', 'null', 'undefined']);

const BUILTINS = new Set([
  'console', 'Math', 'JSON', 'Object', 'Array', 'Map', 'Set',
  'Promise', 'RegExp', 'Date', 'Error', 'window', 'global',
  'document', 'process', 'Buffer', 'setTimeout', 'setInterval',
  'fetch', 'require', 'module', 'exports', '__dirname', '__filename',
  'globalThis', 'isNaN', 'parseInt', 'parseFloat', 'Reflect', 'Proxy',
  'Symbol', 'BigInt', 'Number', 'Boolean', 'String',
]);

function buildWordPattern(words: Set<string>): RegExp {
  const sorted = [...words].sort((a, b) => b.length - a.length || a.localeCompare(b));
  const escaped = sorted.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp('\\b(?:' + escaped.join('|') + ')\\b', 'g');
}

const KEYWORD_PATTERN = buildWordPattern(JS_KEYWORDS);
const TYPE_PATTERN = buildWordPattern(TYPES);
const BUILTIN_PATTERN = buildWordPattern(BUILTINS);

type ScanPattern = {
  pattern: RegExp;
  token: ScanToken;
  allowAt?: (line: string, pos: number) => boolean;
};

const STRING_PATTERNS: ScanPattern[] = [
  { pattern: /'(?:[^'\\]|\\.)*'/g, token: 'string' },
  { pattern: /"(?:[^"\\]|\\.)*"/g, token: 'string' },
  { pattern: /`(?:[^`\\]|\\.)*`/g, token: 'string' },
];

const SLASH_LINE_COMMENT: ScanPattern = {
  pattern: /\/\/.*/g,
  token: 'comment',
  allowAt: (line, pos) => pos === 0 || line[pos - 1] !== ':',
};
const BLOCK_COMMENT: ScanPattern = { pattern: /\/\*[\s\S]*?\*\//g, token: 'comment' };
const HASH_COMMENT: ScanPattern = {
  pattern: /#.*/g,
  token: 'comment',
  allowAt: (line, pos) => pos === 0 || /\s/.test(line[pos - 1] ?? ''),
};
const HTML_COMMENT: ScanPattern = { pattern: /<!--[\s\S]*?-->/g, token: 'comment' };

const MARKUP_PATTERNS: ScanPattern[] = [
  { pattern: /<\/?[a-zA-Z][\w-]*>/g, token: 'tag' },
  { pattern: /<\/?[a-zA-Z][\w-]*/g, token: 'tag' },
  { pattern: /\/?>/g, token: 'tag' },
  { pattern: /[a-zA-Z][\w-]*=(?=["'`{])/g, token: 'attrName' },
];

const NUMBER_PATTERN: ScanPattern = {
  pattern: /\b(?:0[xX][\da-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d*\.\d+|\d+\.\d*|\d+)\b(?!=\w*\()/g,
  token: 'number',
};

const FUNCTION_PATTERN: ScanPattern = {
  pattern: /\b([a-zA-Z_$][\w$]*)\s*\(/g,
  token: 'function',
};

const PUNCTUATION_PATTERNS: ScanPattern[] = [
  { pattern: /[{}()\[\];,.:!?=<>+\-*/%&|^~]=?|=>|\|\||&&|\+\+|--|\.\.\./g, token: 'punctuation' },
  { pattern: /[{}()\[\];,.:!]/g, token: 'punctuation' },
];

const JSON_PATTERNS: ScanPattern[] = [
  ...STRING_PATTERNS,
  { pattern: /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token: 'number' },
  { pattern: /\b(?:true|false|null)\b/g, token: 'number' },
  ...PUNCTUATION_PATTERNS,
];

const GENERIC_PATTERNS: ScanPattern[] = [
  SLASH_LINE_COMMENT,
  BLOCK_COMMENT,
  HASH_COMMENT,
  HTML_COMMENT,
  ...STRING_PATTERNS,
  ...MARKUP_PATTERNS,
  NUMBER_PATTERN,
  { pattern: KEYWORD_PATTERN, token: 'keyword' },
  { pattern: TYPE_PATTERN, token: 'type' },
  { pattern: BUILTIN_PATTERN, token: 'builtin' },
  FUNCTION_PATTERN,
  ...PUNCTUATION_PATTERNS,
];

function classifyReserved(word: string): ScanToken | null {
  if (JS_KEYWORDS.has(word)) return 'keyword';
  if (TYPES.has(word)) return 'type';
  if (BUILTINS.has(word)) return 'builtin';
  return null;
}

function scanLine(line: string, patterns: ScanPattern[]): ScanSpan[] {
  const spans: ScanSpan[] = [];
  let pos = 0;

  const append = (token: ScanToken, text: string) => {
    if (!text) return;
    const previous = spans.at(-1);
    if (previous?.token === token) {
      previous.text += text;
      return;
    }
    spans.push({ token, text });
  };

  while (pos < line.length) {
    let matched = false;
    for (const { pattern, token, allowAt } of patterns) {
      if (allowAt && !allowAt(line, pos)) continue;
      pattern.lastIndex = 0;
      const remaining = line.slice(pos);
      const m = pattern.exec(remaining);
      if (m && m.index === 0) {
        const text = m[0];
        if (token === 'function' && m[1]) {
          const idToken = classifyReserved(m[1]);
          append(idToken ?? 'function', m[1]);
          const rest = text.slice(m[1].length);
          if (rest) append('punctuation', rest);
        } else if (token === 'attrName' && text.includes('=')) {
          const eqIdx = text.indexOf('=');
          append('attrName', text.slice(0, eqIdx));
          append('punctuation', '=');
        } else {
          append(token, text);
        }
        pos += text.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    append('plain', line[pos]!);
    pos += 1;
  }

  return spans;
}

function nextSignificant(spans: ScanSpan[], from: number): ScanSpan | undefined {
  for (let i = from + 1; i < spans.length; i++) {
    if (spans[i]!.token === 'plain' && /^\s*$/.test(spans[i]!.text)) continue;
    return spans[i];
  }
  return undefined;
}

function scanToRole(token: ScanToken): HighlightToken {
  switch (token) {
    case 'comment':
    case 'punctuation':
      return 'structure';
    case 'string':
    case 'attrValue':
    case 'number':
      return 'value';
    case 'keyword':
    case 'function':
    case 'tag':
    case 'attrName':
    case 'builtin':
      return 'name';
    case 'type':
      return 'name';
    default:
      return 'plain';
  }
}

function promoteKeyedStrings(spans: ScanSpan[], isJson: boolean): TokenSpan[] {
  return spans.map((span, index) => {
    if (isJson && span.token === 'string') {
      const next = nextSignificant(spans, index);
      return { token: next?.text.startsWith(':') ? 'name' : 'value', text: span.text };
    }
    if (span.token === 'type' && VALUE_LITERALS.has(span.text)) {
      return { token: 'value', text: span.text };
    }
    return { token: scanToRole(span.token), text: span.text };
  });
}

function mergeRoles(spans: TokenSpan[]): TokenSpan[] {
  const out: TokenSpan[] = [];
  for (const span of spans) {
    if (!span.text) continue;
    const previous = out.at(-1);
    if (previous?.token === span.token) {
      previous.text += span.text;
      continue;
    }
    out.push({ ...span });
  }
  return out;
}

function tokenizeLine(line: string): TokenSpan[] {
  return mergeRoles(promoteKeyedStrings(scanLine(line, GENERIC_PATTERNS), false));
}

export type TokenizedLine = TokenSpan[];

/**
 * Tokenize a code string into lines of coloured spans.
 *
 * @param code  The full code block text.
 * @param language  Language hint from the markdown fence (e.g. `typescript`,
 *                  `json`).  `null` for unfenced blocks.
 */
export function tokenizeCode(code: string, language: string | null): TokenizedLine[] {
  if (language?.trim().toLowerCase() === 'json') {
    // Classify before splitting lines: a JSON key's colon can follow a newline.
    const spans = mergeRoles(promoteKeyedStrings(scanLine(code, JSON_PATTERNS), true));
    const lines: TokenizedLine[] = [[]];
    for (const span of spans) {
      span.text.split('\n').forEach((text, index) => {
        if (index > 0) lines.push([]);
        if (text) lines[lines.length - 1]!.push({ token: span.token, text });
      });
    }
    return lines;
  }
  const lines = code.split('\n');
  return lines.map((line) => tokenizeLine(line));
}

/**
 * Test helper that flattens tokenized output back to the original text.
 */
export function flattenTokens(lines: TokenizedLine[]): string {
  return lines.map((line) => line.map((s) => s.text).join('')).join('\n');
}
