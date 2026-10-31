// The phone talks to Beeline over one connection: the main live WebSocket in
// `apps/mobile/sources/sync/transport/live-connection.ts`. Every other place
// that opens a network connection is listed in `apps/mobile/network-channels.json`
// with its fate. The list may only shrink: a new call site, or a list that grew
// against the base commit, fails CI.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export const ALLOWLIST_PATH = 'apps/mobile/network-channels.json';
export const TRANSPORT_FILE = 'apps/mobile/sources/sync/transport/live-connection.ts';
// `link`: a URL the app shows, opens in the browser or compares against, but never fetches itself.
const FATES = new Set(['main-socket', 'moves-to-socket', 'exception', 'link']);

// Code the phone app runs. Proof harnesses, tests and build-time config live elsewhere.
const SCAN_ROOTS = ['apps/mobile/sources', 'apps/mobile/modules', 'apps/mobile/index.ts'];
const SKIP_DIRS = new Set(['node_modules', 'build', '.gradle', 'Pods', '__tests__', 'test']);
// PDF.js source text, injected into the sandboxed PDF WebView (itself listed below).
const SKIP_FILES = new Set(['apps/mobile/sources/vendor/pdfjs/pdfjs.gen.ts']);
const JS_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const NATIVE_FILE = /\.(kt|java|swift|m|mm)$/;
const TEST_FILE = /\.(test|spec)\.[^.]+$|\.d\.ts$/;

/** Libraries whose job is to open their own network connections. */
export const NETWORK_LIBRARIES = [
  'axios',
  'expo/fetch',
  'livekit-client',
  '@livekit/react-native',
  'nostr-tools/pool',
  'nostr-tools/relay',
  'posthog-react-native',
  'react-native-webview',
  '@sentry/react-native',
  '@tauri-apps/plugin-http',
];

const CALL_KINDS = [
  ['fetch-impl', /\bfetchImpl\s*\(/g],
  ['session-fetch', /\bmonolithSession\s*\.\s*fetch\s*\(/g],
  ['beacon', /\bsendBeacon\b/g],
  // expo-updates and expo-notifications are imported for local metadata too; only these reach the network.
  ['ota-update', /\b(?:checkForUpdateAsync|fetchUpdateAsync)\s*\(/g],
  ['push-token', /\bget(?:Device|Expo)PushTokenAsync\s*\(/g],
];
// Globals that open a connection. Every read of one as a value counts, so an
// alias (`const S = WebSocket`), a qualified or quoted name, or passing it on
// all count. Types, `typeof`, `instanceof` and names a file declares do not.
// `eval` and `Function` count because they can build any of the others from text.
const GLOBAL_KINDS = {
  fetch: 'fetch', WebSocket: 'websocket', XMLHttpRequest: 'xhr', EventSource: 'event-source',
  eval: 'dynamic-code', Function: 'dynamic-code',
};
// Names also common on ordinary objects (`cache.fetch`), so a member read counts only on the global object.
const MEMBER_NAMES_ON_ANY_OBJECT = new Set(['fetch', 'eval', 'Function']);
const GLOBAL_OBJECTS = new Set(['globalThis', 'window', 'self', 'global']);
// React Native's own native modules behind fetch, XMLHttpRequest and WebSocket.
const NATIVE_NETWORK_MODULES = new Set(['Networking', 'WebSocketModule']);
// Read-only constants on the constructor, such as `WebSocket.OPEN`.
const SOCKET_STATES = new Set(['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']);
const DECLARATION_NAMES = new Set([
  ts.SyntaxKind.VariableDeclaration, ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.Parameter, ts.SyntaxKind.PropertyDeclaration, ts.SyntaxKind.PropertySignature,
  ts.SyntaxKind.MethodDeclaration, ts.SyntaxKind.MethodSignature, ts.SyntaxKind.PropertyAssignment,
  ts.SyntaxKind.GetAccessor, ts.SyntaxKind.SetAccessor, ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.ClassExpression, ts.SyntaxKind.InterfaceDeclaration, ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.EnumMember, ts.SyntaxKind.ImportSpecifier, ts.SyntaxKind.ImportClause,
  ts.SyntaxKind.NamespaceImport, ts.SyntaxKind.JsxAttribute, ts.SyntaxKind.TypeParameter,
]);

const unwrap = (node) =>
  ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)
    ? unwrap(node.expression)
    : node;

/** `globalThis`, `window`, `self`, `global`, or one reached through another (`globalThis.window`). */
function isGlobalObject(node) {
  const inner = unwrap(node);
  if (ts.isIdentifier(inner)) return GLOBAL_OBJECTS.has(inner.text);
  return ts.isPropertyAccessExpression(inner) && GLOBAL_OBJECTS.has(inner.name.text) && isGlobalObject(inner.expression);
}

/** Whether a member named `name` on `object` is the network global. `x.fetch` is often a cache; `x.WebSocket` never is. */
const memberIsGlobal = (name, object) => !MEMBER_NAMES_ON_ANY_OBJECT.has(name) || isGlobalObject(object);

/** Resolves names in one file on its own, so a local `window` or `self` is told apart from the global. */
function fileChecker(file, source) {
  const host = {
    getSourceFile: (name) => (name === file ? source : undefined),
    fileExists: (name) => name === file,
    readFile: () => undefined,
    writeFile() {},
    getDefaultLibFileName: () => 'lib.d.ts',
    getCurrentDirectory: () => '',
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  };
  return ts.createProgram([file], { noLib: true, noResolve: true, allowJs: true, types: [] }, host).getTypeChecker();
}

/** `globalThis`, or `window`, `self` or `global` that the file does not declare itself (a `declare` still means the global). */
function namesGlobalObject(node, checker) {
  if (ts.isIdentifier(node)) {
    if (!GLOBAL_OBJECTS.has(node.text)) return false;
    const parent = node.parent;
    // A declared name, a member name (`x.window`, judged as a whole) or a destructured name (judged at its source).
    if (DECLARATION_NAMES.has(parent.kind) && parent.name === node) return false;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
    if (ts.isBindingElement(parent)) return false;
    const symbol = ts.isShorthandPropertyAssignment(parent)
      ? checker().getShorthandAssignmentValueSymbol(parent)
      : checker().getSymbolAtLocation(node);
    const declarations = symbol?.declarations ?? [];
    return declarations.every((d) => d.flags & ts.NodeFlags.Ambient || ts.getCombinedModifierFlags(d) & ts.ModifierFlags.Ambient);
  }
  return ts.isPropertyAccessExpression(node) && GLOBAL_OBJECTS.has(node.name.text) && isGlobalObject(node.expression);
}

/**
 * Whether the global object at `node` is handed on whole: saved under another
 * name, passed to a function, spread, or read with a computed key. Through
 * any of those, `g.fetch(url)` opens a connection this check cannot see.
 * Reading a named member, `typeof`, `in` and plain destructuring do not.
 */
function globalObjectEscapes(node) {
  let child = node;
  let parent = node.parent;
  while (
    ts.isParenthesizedExpression(parent) || ts.isNonNullExpression(parent) ||
    ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent) || ts.isTypeAssertionExpression(parent)
  ) {
    child = parent;
    parent = parent.parent;
  }
  if (ts.isPropertyAccessExpression(parent) && parent.expression === child) return false;
  if (ts.isElementAccessExpression(parent) && parent.expression === child) return !ts.isStringLiteralLike(parent.argumentExpression);
  if (ts.isTypeOfExpression(parent) || ts.isTypeQueryNode(parent) || ts.isQualifiedName(parent)) return false;
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.InKeyword && parent.right === child) return false;
  if (ts.isVariableDeclaration(parent) && parent.initializer === child && ts.isObjectBindingPattern(parent.name))
    return parent.name.elements.some((element) => {
      const key = element.propertyName ?? element.name;
      return element.dotDotDotToken || !ts.isIdentifier(key) || GLOBAL_OBJECTS.has(key.text);
    });
  return true;
}

/** Whether this mention of a network global reads its value, as opposed to naming a type or a declaration. */
function readsGlobal(node) {
  const parent = node.parent;
  if (ts.isTypeReferenceNode(parent) || ts.isTypeQueryNode(parent) || ts.isQualifiedName(parent)) return false;
  if (ts.isExpressionWithTypeArguments(parent)) {
    const clause = parent.parent;
    return clause.token === ts.SyntaxKind.ExtendsKeyword && !ts.isInterfaceDeclaration(clause.parent);
  }
  if (ts.isTypeOfExpression(parent)) return false;
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && parent.right === node)
    return false;
  if (ts.isPropertyAccessExpression(parent)) {
    if (parent.name === node) return memberIsGlobal(node.text, parent.expression);
    return !SOCKET_STATES.has(parent.name.text);
  }
  if (ts.isBindingElement(parent)) {
    // `const { WebSocket: S } = globalThis` reads it; any other destructured name is a local.
    if ((parent.propertyName ?? parent.name) !== node) return false;
    let root = parent.parent;
    while (ts.isBindingElement(root.parent)) root = root.parent.parent;
    const declaration = root.parent;
    return Boolean(declaration.initializer) && isGlobalObject(declaration.initializer);
  }
  if (DECLARATION_NAMES.has(parent.kind) && parent.name === node) return false;
  return true;
}

/** Reads of `fetch`, `WebSocket`, `XMLHttpRequest` and `EventSource` in one JavaScript or TypeScript file. */
function scanGlobals(file, text) {
  const kind = /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : /\.ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const hits = [];
  let checker;
  const getChecker = () => (checker ??= fileChecker(file, source));
  const lineOf = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const add = (name, node) => hits.push({ kind: GLOBAL_KINDS[name], line: lineOf(node) });
  const visit = (node) => {
    if (ts.isIdentifier(node) && Object.hasOwn(GLOBAL_KINDS, node.text) && readsGlobal(node)) add(node.text, node);
    if ((ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) && namesGlobalObject(node, getChecker) && globalObjectEscapes(node))
      hits.push({ kind: 'global-object', line: lineOf(node) });
    // `(() => {}).constructor` is `Function`.
    if ((ts.isPropertyAccessExpression(node) && node.name.text === 'constructor') ||
      (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === 'constructor'))
      hits.push({ kind: 'dynamic-code', line: lineOf(node) });
    // `NativeModules.Networking`, `TurboModuleRegistry.get('WebSocketModule')`
    if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && NATIVE_NETWORK_MODULES.has(node.text))
      hits.push({ kind: 'native-http', line: lineOf(node) });
    // `globalThis['WebSocket']`
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
      const name = node.argumentExpression.text;
      if (Object.hasOwn(GLOBAL_KINDS, name) && memberIsGlobal(name, node.expression)) add(name, node.argumentExpression);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

const NATIVE_KINDS = [
  ['native-http', /\b(?:openConnection|newCall|newWebSocket|dataTask|uploadTask|downloadTask|webSocketTask)\s*\(/g],
];

/**
 * Comments removed, and (when `blankStrings`) string and template text replaced
 * with spaces, so a mention in prose or a URL never counts as a call. Newlines
 * survive so offsets still map to lines.
 */
export function stripSource(text, { blankStrings }) {
  let out = '';
  let i = 0;
  const templates = []; // brace depth at each `${` opened inside a template literal
  let depth = 0;
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += blank(text.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '/' && startsRegex(out)) {
      let j = i + 1;
      let inClass = false;
      while (j < text.length && text[j] !== '\n' && (inClass || text[j] !== '/')) {
        if (text[j] === '\\') j++;
        else if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
        j++;
      }
      const body = text.slice(i + 1, j);
      out += '/' + (blankStrings ? blank(body) : body);
      i = j;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`' || (c === '}' && templates.length && templates.at(-1) === depth)) {
      if (c === '}') templates.pop();
      const quote = c === '}' ? '`' : c;
      let j = i + 1;
      while (j < text.length && text[j] !== quote) {
        if (text[j] === '\\') j++;
        else if (quote === '`' && text[j] === '$' && text[j + 1] === '{') break;
        else if (quote !== '`' && text[j] === '\n') break;
        j++;
      }
      const opensExpression = quote === '`' && text[j] === '$';
      const stop = opensExpression ? j + 2 : Math.min(j + 1, text.length);
      const body = text.slice(i + 1, j);
      out += c + (blankStrings ? blank(body) : body) + text.slice(j, stop);
      if (opensExpression) templates.push(depth);
      i = stop;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    out += c;
    i++;
  }
  return out;
}

/** A `/` after these starts a regular expression, not a division. */
function startsRegex(before) {
  const trimmed = before.trimEnd();
  if (!trimmed) return true;
  if (/[(,=:[!&|?{};+\-*%<>~^]$/.test(trimmed)) return true;
  return /\b(?:return|typeof|case|in|of|void|throw|new|delete|instanceof)$/.test(trimmed);
}

function lineAt(text, index) {
  let line = 1;
  for (let k = 0; k < index; k++) if (text.charCodeAt(k) === 10) line++;
  return line;
}

/** Network call sites in one source file: `[{ kind, line }]`. */
export function scanSource(file, text) {
  const hits = [];
  const add = (kind, source, pattern) => {
    for (const match of source.matchAll(pattern)) hits.push({ kind, line: lineAt(source, match.index) });
  };
  if (NATIVE_FILE.test(file)) {
    const code = stripSource(text, { blankStrings: true });
    for (const [kind, pattern] of NATIVE_KINDS) add(kind, code, pattern);
    return hits;
  }
  const bare = stripSource(text, { blankStrings: true });
  for (const [kind, pattern] of CALL_KINDS) add(kind, bare, pattern);
  hits.push(...scanGlobals(file, text));
  // A type-only import loads nothing at run time.
  const code = stripSource(text, { blankStrings: false })
    .replace(/^\s*import\s+type\b[^;]*;/gm, (statement) => statement.replace(/[^\n]/g, ' '));
  // A new host is a new channel even through an existing call (the hedged backup origin was one).
  for (const match of code.matchAll(/['"`](?:https?|wss?):\/\/([a-zA-Z0-9.-]+)/g))
    hits.push({ kind: `origin:${match[1].toLowerCase()}`, line: lineAt(code, match.index) });
  for (const name of NETWORK_LIBRARIES) {
    const quoted = name.replace(/[/.@-]/g, '\\$&');
    const imports = new RegExp(
      `(?:\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\brequire\\s*\\(\\s*|^\\s*import\\s+)['"]${quoted}(?:/[^'"]*)?['"]`,
      'gm',
    );
    add(`import:${name}`, code, imports);
  }
  return hits.sort((a, b) => a.line - b.line);
}

function walk(root, relative, files) {
  const absolute = path.join(root, relative);
  let entries;
  try {
    entries = readdirSync(absolute, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOTDIR') {
      files.push(relative);
      return;
    }
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const child = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(root, child, files);
    } else files.push(child);
  }
}

/** Every network call site in the phone app, keyed `file::kind`. */
export function scanPhoneTree(root) {
  const files = [];
  for (const start of SCAN_ROOTS) walk(root, start, files);
  const sites = new Map();
  for (const file of files.sort()) {
    if (SKIP_FILES.has(file) || TEST_FILE.test(file)) continue;
    if (!JS_FILE.test(file) && !NATIVE_FILE.test(file)) continue;
    for (const hit of scanSource(file, readFileSync(path.join(root, file), 'utf8'))) {
      const key = `${file}::${hit.kind}`;
      const site = sites.get(key) ?? { file, kind: hit.kind, lines: [] };
      site.lines.push(hit.line);
      sites.set(key, site);
    }
  }
  return sites;
}

export function allowlistAtRef(root, ref) {
  try {
    return JSON.parse(
      execFileSync('git', ['show', `${ref}:${ALLOWLIST_PATH}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
    );
  } catch {
    return undefined; // the list did not exist at base: this is the change that adds it
  }
}

const keyOf = (entry) => `${entry.file}::${entry.kind}`;

/** Every way the tree and the list disagree, as printable messages. */
export function judgeChannels(sites, allowlist, baseAllowlist) {
  const errors = [];
  const allowed = new Map();
  for (const entry of allowlist.entries ?? []) {
    const key = keyOf(entry);
    if (allowed.has(key)) errors.push(`${ALLOWLIST_PATH}: ${key} is listed twice`);
    if (!Number.isInteger(entry.count) || entry.count < 1)
      errors.push(`${ALLOWLIST_PATH}: ${key} needs a positive whole count`);
    if (!FATES.has(entry.fate))
      errors.push(`${ALLOWLIST_PATH}: ${key} fate must be one of ${[...FATES].join(', ')}`);
    if (typeof entry.why !== 'string' || entry.why.trim().length < 10)
      errors.push(`${ALLOWLIST_PATH}: ${key} needs a "why"`);
    if (entry.fate === 'main-socket' && entry.file !== TRANSPORT_FILE)
      errors.push(`${ALLOWLIST_PATH}: ${key} only ${TRANSPORT_FILE} holds the main socket`);
    allowed.set(key, entry);
  }
  for (const [key, site] of sites) {
    const entry = allowed.get(key);
    const at = site.lines.map((line) => `${site.file}:${line}`).join(', ');
    if (!entry)
      errors.push(`new phone network call site (${site.kind}) at ${at}. Send it over the main live socket in ${TRANSPORT_FILE} instead.`);
    else if (site.lines.length > entry.count)
      errors.push(`${site.kind} call sites in ${site.file} grew from ${entry.count} to ${site.lines.length} (${at}). Send the new one over the main live socket instead.`);
    else if (site.lines.length < entry.count)
      errors.push(`${ALLOWLIST_PATH}: ${key} is now ${site.lines.length}, not ${entry.count}. Shrink the entry.`);
  }
  for (const [key] of allowed)
    if (!sites.has(key)) errors.push(`${ALLOWLIST_PATH}: ${key} has no call sites left. Remove the entry.`);
  if (baseAllowlist) {
    const before = new Map((baseAllowlist.entries ?? []).map((entry) => [keyOf(entry), entry]));
    for (const [key, entry] of allowed) {
      const was = before.get(key);
      if (!was) errors.push(`${ALLOWLIST_PATH}: ${key} is new. The list of phone network channels may only shrink.`);
      else if (entry.count > was.count)
        errors.push(`${ALLOWLIST_PATH}: ${key} grew from ${was.count} to ${entry.count}. The list of phone network channels may only shrink.`);
    }
  }
  return errors;
}
