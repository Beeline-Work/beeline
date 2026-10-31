import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ALLOWLIST_PATH, judgeChannels, scanPhoneTree, scanSource, TRANSPORT_FILE } from './phone-network-channels.mjs';

const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const allowlist = JSON.parse(readFileSync(path.join(repo, ALLOWLIST_PATH), 'utf8'));
const scratch = mkdtempSync(path.join(tmpdir(), 'phone-network-channels-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A throwaway copy of the phone sources, the list and the checker. */
function copyOfRepo(name) {
  const root = path.join(scratch, name);
  for (const part of ['apps/mobile/sources', 'apps/mobile/modules', 'apps/mobile/index.ts', ALLOWLIST_PATH, 'scripts/phone-network-channels.mjs', 'scripts/check-phone-network-channels.mjs'])
    cpSync(path.join(repo, part), path.join(root, part), {
      recursive: true,
      filter: (source) => !['node_modules', 'build', '.gradle'].includes(path.basename(source)),
    });
  // The checker parses with the repository's TypeScript.
  symlinkSync(path.join(repo, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  return root;
}

function runCheck(root, ...extra) {
  return spawnSync(process.execPath, [path.join(root, 'scripts/check-phone-network-channels.mjs'), '--root', root, ...extra], {
    encoding: 'utf8',
  });
}

function write(root, file, text) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
}

test('the phone tree matches its channel list', () => {
  assert.deepEqual(judgeChannels(scanPhoneTree(repo), allowlist), []);
});

test('only the transport module holds the main socket', () => {
  const sockets = allowlist.entries.filter((entry) => entry.fate === 'main-socket');
  assert.deepEqual(sockets.map((entry) => [entry.file, entry.kind, entry.count]), [[TRANSPORT_FILE, 'websocket', 1]]);
});

test('a new fetch( outside the transport module fails the check', () => {
  const root = copyOfRepo('new-fetch');
  assert.equal(runCheck(root).status, 0);
  write(root, 'apps/mobile/sources/buzz/side-channel.ts', "export const ping = () => fetch('https://example.com/ping');\n");
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /new phone network call site \(fetch\) at apps\/mobile\/sources\/buzz\/side-channel\.ts:1/);
});

test('a new WebSocket( outside the transport module fails the check', () => {
  const root = copyOfRepo('new-socket');
  write(root, 'apps/mobile/sources/sync/second-socket.ts', "export const open = (url: string) => new WebSocket(url);\n");
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /new phone network call site \(websocket\) at apps\/mobile\/sources\/sync\/second-socket\.ts:1/);
});

test('a socket or fetch reached through a qualified global fails the check', () => {
  const root = copyOfRepo('qualified-globals');
  write(root, 'apps/mobile/sources/sync/review-side-channel.ts', [
    'export const sideChannel = (url: string) => new globalThis.WebSocket(url);',
    'export const viaWindow = (url: string) => new window.WebSocket(url);',
    'export const viaSelf = (url: string) => new self?.WebSocket(url);',
    'const Socket = global.WebSocket;',
    "export const quoted = (url: string) => new globalThis['WebSocket'](url);",
    "export const quotedFetch = (url: string) => window['fetch'](url);",
    'export const optionalFetch = (url: string) => globalThis?.fetch(url);',
    'export const kind: typeof globalThis.WebSocket = Socket;',
    '',
  ].join('\n'));
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /new phone network call site \(websocket\) at (?:\S+review-side-channel\.ts:\d+, ){4}\S+review-side-channel\.ts:5\./);
  assert.match(result.stderr, /new phone network call site \(fetch\) at \S+review-side-channel\.ts:6, \S+review-side-channel\.ts:7\./);
  assert.doesNotMatch(result.stderr, /review-side-channel\.ts:8/);
});

test('a socket constructor read as a bare value fails the check', () => {
  const root = copyOfRepo('bare-alias');
  // The exact file from review: an alias of the bare global, then `new` on the alias.
  write(root, 'apps/mobile/sources/sync/review-side-channel.ts',
    'const Socket = WebSocket; export const sideChannel = (url: string) => new Socket(url);\n');
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /new phone network call site \(websocket\) at apps\/mobile\/sources\/sync\/review-side-channel\.ts:1\./);
});

test('every other way to reach a network global counts, and types do not', () => {
  const text = [
    'const Socket = WebSocket;',
    'export const passed = Reflect.construct(WebSocket, [url]);',
    'const { WebSocket: Destructured } = globalThis;',
    'const { fetch: send } = window;',
    'export const ctors = { ctor: WebSocket, request: XMLHttpRequest, stream: EventSource };',
    'export const shorthand = { fetch };',
    'class Sub extends WebSocket {}',
    'const g = globalThis; export const viaAlias = new g.WebSocket(url);',
    "export const quotedAlias = new g['EventSource'](url);",
    'export const nested = globalThis.window.fetch;',
    'export const later = cond ? undefined : WebSocket;',
    'let held: WebSocket | undefined;',
    'function isOpen(socket: WebSocket, request: XMLHttpRequest): socket is WebSocket { return socket.readyState === WebSocket.OPEN; }',
    'type Ctor = typeof WebSocket | typeof globalThis.fetch;',
    'interface Wrapped extends WebSocket {}',
    "if (typeof EventSource !== 'undefined' && held instanceof WebSocket) cache.fetch(key);",
    'const { fetch: localName } = props;',
    'export const options = { fetch: read };',
    '',
  ].join('\n');
  const lines = (kind) => scanSource('apps/mobile/sources/example.ts', text).filter((hit) => hit.kind === kind).map((hit) => hit.line);
  assert.deepEqual(lines('websocket'), [1, 2, 3, 5, 7, 8, 11]);
  assert.deepEqual(lines('fetch'), [4, 6, 10]);
  assert.deepEqual(lines('xhr'), [5]);
  assert.deepEqual(lines('event-source'), [5, 9]);
});

test('fetch through another name for the global object fails the check, and cache.fetch does not', () => {
  const root = copyOfRepo('global-alias');
  // The exact file from review: an alias of globalThis, then fetch on the alias.
  write(root, 'apps/mobile/sources/sync/review-side-channel.ts',
    'const g = globalThis; export const sideChannel = (url: string) => g.fetch(url);\n');
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /new phone network call site \(global-object\) at apps\/mobile\/sources\/sync\/review-side-channel\.ts:1\./);
  write(root, 'apps/mobile/sources/sync/review-side-channel.ts',
    'const cache = { fetch: (key: string) => key }; export const read = (key: string) => cache.fetch(key);\n');
  const clean = runCheck(root);
  assert.equal(clean.status, 0, clean.stderr);
});

test('handing on the global object, eval and the native network modules count, and plain reads do not', () => {
  const text = [
    'const g = globalThis;',
    'export const passed = Reflect.get(window, "fetch");',
    'export const computed = globalThis[name];',
    'export const nested = keep(globalThis.window);',
    'const o = { self };',
    'const { window: w } = globalThis;',
    'const { ...rest } = global;',
    'declare const self: any; export const declared = self;',
    'export const typed = globalThis as unknown as { f: typeof fetch };',
    'export const built = new Function("return 1"); eval("1"); globalThis.eval("1"); f.constructor; f["constructor"];',
    'NativeModules.Networking; TurboModuleRegistry.get("WebSocketModule");',
    'window.addEventListener("storage", f); globalThis.__DEV__; globalThis["x"];',
    'if (typeof window !== "undefined" && "PushManager" in window) cache.eval(key);',
    'const { addEventListener, location } = window;',
    'function local(window: Target, self: Target) { return [window, self]; }',
    'let handler: Function; const label = { window: 1, self: 2 }; x.window; x.self;',
    '',
  ].join('\n');
  const lines = (kind) => scanSource('apps/mobile/sources/example.ts', text).filter((hit) => hit.kind === kind).map((hit) => hit.line);
  assert.deepEqual(lines('global-object'), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(lines('dynamic-code'), [10, 10, 10, 10, 10]);
  assert.deepEqual(lines('native-http'), [11, 11]);
});

test('a second socket in the transport module fails the check', () => {
  const root = copyOfRepo('second-main-socket');
  const file = path.join(root, TRANSPORT_FILE);
  writeFileSync(file, `${readFileSync(file, 'utf8')}\nexport const spare = (url: string) => new WebSocket(url);\n`);
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /websocket call sites in .*live-connection\.ts grew from 1 to 2/);
});

test('another call in a listed file fails the check', () => {
  const root = copyOfRepo('grown-file');
  const file = path.join(root, 'apps/mobile/sources/buzz/store-update.ts');
  writeFileSync(file, `${readFileSync(file, 'utf8')}\nexport const again = () => fetch('/v1/public/other');\n`);
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /fetch call sites in apps\/mobile\/sources\/buzz\/store-update\.ts grew from 1 to 2/);
});

test('a new host in a listed file fails the check, as the hedged backup origin would have', () => {
  const root = copyOfRepo('new-origin');
  const file = path.join(root, 'apps/mobile/sources/sync/transport/monolith-operation.ts');
  writeFileSync(file, `${readFileSync(file, 'utf8')}\nexport const BACKUP_ORIGIN = 'https://backup-server.example.net';\n`);
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /new phone network call site \(origin:backup-server\.example\.net\) at .*monolith-operation\.ts:\d+/);
});

test('a network library, native request or raw XHR anywhere else fails the check', () => {
  const root = copyOfRepo('other-channels');
  write(root, 'apps/mobile/sources/buzz/stream.ts', [
    "import axios from 'axios';",
    'export const events = (url: string) => new EventSource(url);',
    'export const xhr = () => new XMLHttpRequest();',
    'export const send = globalThis.fetch;',
    '',
  ].join('\n'));
  write(root, 'apps/mobile/modules/extra/android/src/main/java/Extra.kt', 'val c = java.net.URL(u).openConnection()\n');
  const result = runCheck(root);
  assert.equal(result.status, 1);
  for (const kind of ['import:axios', 'event-source', 'xhr', 'fetch', 'native-http'])
    assert.match(result.stderr, new RegExp(`new phone network call site \\(${kind}\\)`));
});

test('mentions in comments, strings and regular expressions do not count', () => {
  const text = [
    '// fetch(url) and new WebSocket(url) in a comment',
    '/* XMLHttpRequest */',
    "const copy = 'Failed to fetch(). new WebSocket(';",
    'const pattern = /fetch failed|EventSource/i;',
    'const shape: typeof fetch = request;',
    'cache.fetch(address, guard, read);',
    'const options = { fetch: read };',
    "import type { WebViewProps } from 'react-native-webview';",
    '',
  ].join('\n');
  assert.deepEqual(scanSource('apps/mobile/sources/example.ts', text), []);
});

test('the list may only shrink against the base branch', () => {
  const sites = scanPhoneTree(repo);
  const base = structuredClone(allowlist);
  const grown = structuredClone(allowlist);
  grown.entries.find((entry) => entry.kind === 'websocket').count = 2;
  const errors = judgeChannels(sites, grown, base);
  assert.ok(errors.some((error) => /grew from 1 to 2\. The list of phone network channels may only shrink/.test(error)));
  const smaller = structuredClone(allowlist);
  smaller.entries = smaller.entries.filter((entry) => entry.kind !== 'websocket');
  assert.ok(judgeChannels(sites, allowlist, smaller).some((error) => /live-connection\.ts::websocket is new/.test(error)));
});

test('listing a new site in the same change still fails against the base branch', () => {
  const root = copyOfRepo('listed-new-site');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], { cwd: root });
  write(root, 'apps/mobile/sources/buzz/side-channel.ts', "export const ping = () => fetch('/v1/ping');\n");
  const list = JSON.parse(readFileSync(path.join(root, ALLOWLIST_PATH), 'utf8'));
  list.entries.push({ file: 'apps/mobile/sources/buzz/side-channel.ts', kind: 'fetch', count: 1, fate: 'exception', why: 'An agent says it is needed.' });
  writeFileSync(path.join(root, ALLOWLIST_PATH), JSON.stringify(list, null, 2));
  assert.equal(runCheck(root).status, 0);
  const result = runCheck(root, '--base', 'HEAD');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /side-channel\.ts::fetch is new\. The list of phone network channels may only shrink/);
});

test('a stale entry must be removed once its call site is gone', () => {
  const sites = scanPhoneTree(repo);
  sites.delete('apps/mobile/sources/buzz/store-update.ts::fetch');
  assert.ok(judgeChannels(sites, allowlist).some((error) => /store-update\.ts::fetch has no call sites left/.test(error)));
});
