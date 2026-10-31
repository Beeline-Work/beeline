// The phone talks to Beeline over one connection: the main live WebSocket in
// `apps/mobile/sources/sync/transport/live-connection.ts`. Every other place
// that opens a network connection is listed in `apps/mobile/network-channels.json`
// with its fate. The list may only shrink: a new call site, or a list that grew
// against the base commit, fails CI.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

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
  // Calls and values (`const send = fetch`); not types, definitions or object keys.
  ['fetch', /(?<![\w$.]|typeof\s+|(?:async|function)\s+)(?:(?:globalThis|window|self|global)\s*\.\s*)?fetch(?![\w$]|\s*\??:(?!:)|\s*<)/g],
  ['fetch-impl', /\bfetchImpl\s*\(/g],
  ['session-fetch', /\bmonolithSession\s*\.\s*fetch\s*\(/g],
  ['websocket', /\bnew\s+WebSocket\b/g],
  ['xhr', /\bXMLHttpRequest\b/g],
  ['event-source', /\bEventSource\b/g],
  ['beacon', /\bsendBeacon\b/g],
  // expo-updates and expo-notifications are imported for local metadata too; only these reach the network.
  ['ota-update', /\b(?:checkForUpdateAsync|fetchUpdateAsync)\s*\(/g],
  ['push-token', /\bget(?:Device|Expo)PushTokenAsync\s*\(/g],
];
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
