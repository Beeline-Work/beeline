/**
 * Lightweight, zero-dependency syntax tokenizer for React Native.
 *
 * Produces an array of `{token, text}` pairs that a renderer can map
 * to styled `<Text>` spans.  Designed for code blocks in chat bubbles,
 * not for IDE-grade accuracy — covers the common cases and degrades
 * gracefully to plain text for anything it doesn't recognise.
 *
 * DESIGN: keyword/type/builtin words are matched as literal word-boundary
 * patterns so they never get merged into a plain-text run.  The function-call
 * pattern (ident followed by `(`) is checked AFTER those, so `async ()`
 * emits `keyword async` + `punctuation (` not `function async` + `(`.
 */

export type HighlightToken =
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
  /** The token type when nothing matched — stays on the base colour. */
  | 'plain';

type TokenSpan = { token: HighlightToken; text: string };

// ---------------------------------------------------------------------------
// Language keyword sets
// ---------------------------------------------------------------------------

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

const BUILTINS = new Set([
  'console', 'Math', 'JSON', 'Object', 'Array', 'Map', 'Set',
  'Promise', 'RegExp', 'Date', 'Error', 'window', 'global',
  'document', 'process', 'Buffer', 'setTimeout', 'setInterval',
  'fetch', 'require', 'module', 'exports', '__dirname', '__filename',
  'globalThis', 'isNaN', 'parseInt', 'parseFloat', 'Reflect', 'Proxy',
  'Symbol', 'BigInt', 'Number', 'Boolean', 'String',
]);

// ---------------------------------------------------------------------------
// Build word-boundary patterns for keyword/type/builtin sets
// ---------------------------------------------------------------------------

function buildWordPattern(words: Set<string>): RegExp {
  // Sort by length descending so longer words match before shorter substrings.
  const sorted = [...words].sort((a, b) => b.length - a.length || a.localeCompare(b));
  const escaped = sorted.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp('\\b(?:' + escaped.join('|') + ')\\b', 'g');
}

const KEYWORD_PATTERN = buildWordPattern(JS_KEYWORDS);
const TYPE_PATTERN = buildWordPattern(TYPES);
const BUILTIN_PATTERN = buildWordPattern(BUILTINS);

// ---------------------------------------------------------------------------
// Regex-based tokenizer
// ---------------------------------------------------------------------------

const TOKEN_PATTERNS: { pattern: RegExp; token: HighlightToken }[] = [
  // Comments must come first so they don't get consumed by keyword/string patterns.
  { pattern: /\/\/.*/g, token: 'comment' },
  { pattern: /\/\*[\s\S]*?\*\//g, token: 'comment' },
  { pattern: /#.*/g, token: 'comment' },
  { pattern: /<!--[\s\S]*?-->/g, token: 'comment' },

  // Strings (single, double, backtick, heredoc-like)
  { pattern: /'(?:[^'\\]|\\.)*'/g, token: 'string' },
  { pattern: /"(?:[^"\\]|\\.)*"/g, token: 'string' },
  { pattern: /`(?:[^`\\]|\\.)*`/g, token: 'string' },

  // Markup tags and attributes (HTML, JSX, TSX)
  { pattern: /<\/?[a-zA-Z][\w-]*>/g, token: 'tag' },
  { pattern: /<\/?[a-zA-Z][\w-]*/g, token: 'tag' },
  { pattern: /\/?>/g, token: 'tag' },
  { pattern: /[a-zA-Z][\w-]*=(?=["'`{])/g, token: 'attrName' },

  // Numbers (integers, floats, hex, binary)
  { pattern: /\b(?:0[xX][\da-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d*\.\d+|\d+\.\d*|\d+)\b(?!=\w*\()/g, token: 'number' },

  // Keywords, types, and built-ins — matched as standalone word-boundary
  // patterns so they never merge into a plain-text run.
  { pattern: KEYWORD_PATTERN, token: 'keyword' },
  { pattern: TYPE_PATTERN, token: 'type' },
  { pattern: BUILTIN_PATTERN, token: 'builtin' },

  // Function calls: identifier followed by ( — matches the name part only.
  // Must come AFTER keyword/type/builtin so `async (` is caught as keyword + punctuation.
  { pattern: /\b([a-zA-Z_$][\w$]*)\s*\(/g, token: 'function' },

  // Punctuation and operators
  { pattern: /[{}()\[\];,.:!?=<>+\-*/%&|^~]=?|=>|\|\||&&|\+\+|--|\.\.\./g, token: 'punctuation' },
  { pattern: /[{}()\[\];,.:!]/g, token: 'punctuation' },
];

/**
 * Tokenize a single line of source code.
 */
function tokenizeLine(line: string, _language: string | null): TokenSpan[] {
  const spans: TokenSpan[] = [];
  let pos = 0;

  while (pos < line.length) {
    let matched = false;
    for (const { pattern, token } of TOKEN_PATTERNS) {
      pattern.lastIndex = 0;
      const remaining = line.slice(pos);
      const m = pattern.exec(remaining);
      if (m && m.index === 0) {
        const text = m[0];
        if (token === 'function' && m[1]) {
          // The capture group is the identifier; the rest (`(`, maybe with
          // whitespace captured by \s*) is punctuation.  If the identifier
          // happens to be a keyword/type/builtin (e.g. `async (`) we keep
          // the better classification instead of calling it a function.
          const idToken = classifyReserved(m[1]);
          spans.push({ token: idToken ?? 'function', text: m[1] });
          const rest = text.slice(m[1].length);
          if (rest) {
            spans.push({ token: 'punctuation', text: rest });
          }
        } else if (token === 'tag' && text.startsWith('</')) {
          // Closing tag — whole token is a tag
          spans.push({ token: 'tag', text });
        } else if (token === 'tag' && text.length > 1 && text.endsWith('>')) {
          // Self-closing or opening tag — whole token is a tag
          spans.push({ token: 'tag', text });
        } else if (token === 'attrName') {
          // The match is `name=`; split the value assignment punctuation
          const eqIdx = text.indexOf('=');
          spans.push({ token: 'attrName', text: text.slice(0, eqIdx) });
          spans.push({ token: 'punctuation', text: '=' });
        } else {
          spans.push({ token, text });
        }
        pos += text.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // Not matched by any pattern — emit the current character as plain text.
    // Consume one character at a time to avoid merging distinct words/tokens.
    spans.push({ token: 'plain', text: line[pos] });
    pos += 1;
  }

  return spans;
}

/**
 * Check if a word is a reserved identifier (keyword, type, builtin).
 * Returns the token type or null if it's just a plain identifier.
 */
function classifyReserved(word: string): HighlightToken | null {
  if (JS_KEYWORDS.has(word)) return 'keyword';
  if (TYPES.has(word)) return 'type';
  if (BUILTINS.has(word)) return 'builtin';
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type TokenizedLine = TokenSpan[];

/**
 * Tokenize a code string into lines of coloured spans.
 *
 * @param code  The full code block text.
 * @param language  Language hint from the markdown fence (e.g. `typescript`,
 *                  `python`).  `null` for unfenced blocks.
 */
export function tokenizeCode(code: string, language: string | null): TokenizedLine[] {
  const lines = code.split('\n');
  return lines.map((line) => tokenizeLine(line, language));
}

/**
 * Test helper that flattens tokenized output back to the original text.
 */
export function flattenTokens(lines: TokenizedLine[]): string {
  return lines.map((line) => line.map((s) => s.text).join('')).join('\n');
}