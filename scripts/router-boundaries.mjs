// Additive gate: the original phone scanner and its manifest stay authoritative.
import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import ts from 'typescript';
import { scanSource, NETWORK_LIBRARIES } from './phone-network-channels.mjs';

export const INVENTORY = 'packages/net/migration-sites.json';
const ROOTS = ['apps/server/src', 'apps/body/src', 'apps/api/src', 'apps/auth/src', 'apps/mobile/sources', 'apps/mobile/modules',
  'apps/mobile/index.ts', 'apps/mobile/src-tauri/src', 'packages'];
const PUBLIC_ENTRIES = ['packages/net/src/index.ts', 'packages/net/src/helper-codecs.ts', 'packages/net/src/helper-activation-codecs.ts', 'packages/net/src/helper-turn-codecs.ts'];
const SKIP = new Set(['node_modules', 'dist', 'build', '.git', 'target', 'Pods', '__tests__', 'fixtures']);
const SOURCE = /\.(?:[cm]?[jt]sx?|swift|kt|java|m|mm|rs)$/;
const TEST = /\.(?:test|spec|typecheck)\.[^.]+$|\.d\.ts$|\/test-support[^/]*\.[^.]+$/;
const LIBRARIES = [...NETWORK_LIBRARIES, 'node:http', 'node:https', 'node:http2', 'node:net',
  'node:tls', 'node:dgram', 'http', 'https', 'http2', 'net', 'tls', 'dgram', 'ws', 'pg',
  'undici', 'openai', '@anthropic-ai/sdk', '@google/genai', '@modelcontextprotocol/sdk',
  'firebase-admin', 'web-push', 'livekit-server-sdk', '@livekit/rtc-node', 'aws4fetch',
  '@sentry/node', '@sentry/bun'];

// This dispatcher configures the existing MCP fetch leaf; it cannot itself be
// called or exported as another request path. Fail closed on any structural
// change or escape. All actual fetches remain inventoried by the normal gate.
function configuredMcpDispatcher(file, source) {
  if (file !== 'apps/body/src/session-join/beeline-api.ts') return false;
  const printer = ts.createPrinter({ removeComments: true });
  const expected = ts.createSourceFile('expected.ts', `class MemberStreamAgent extends Agent {
    override dispatch(options: Parameters<Agent['dispatch']>[0], handler: Parameters<Agent['dispatch']>[1]): ReturnType<Agent['dispatch']> {
      return super.dispatch({ ...options, bodyTimeout: 0 }, handler);
    }
  }`, ts.ScriptTarget.Latest, true);
  const normalize = (node, tree) => printer.printNode(ts.EmitHint.Unspecified, node, tree).replace(/\s+/g, '');
  const classes = source.statements.filter(node => ts.isClassDeclaration(node) && node.name?.text === 'MemberStreamAgent');
  if (classes.length !== 1 || normalize(classes[0], source) !== normalize(expected.statements[0], expected)) return false;
  const bindings = source.statements.filter(node => ts.isImportDeclaration(node) && node.moduleSpecifier.text === 'undici');
  if (bindings.length !== 1) return false;
  const imported = bindings[0].importClause;
  if (!imported || imported.name || !imported.namedBindings || !ts.isNamedImports(imported.namedBindings) ||
      imported.namedBindings.elements.length !== 1 || imported.namedBindings.elements[0].name.text !== 'Agent' ||
      imported.namedBindings.elements[0].propertyName) return false;
  let valid = true, instances = 0, dispatchers = 0;
  const inType = node => {
    for (let parent = node.parent; parent; parent = parent.parent) if (ts.isTypeNode(parent)) return true;
    return false;
  };
  function visit(node) {
    if (ts.isIdentifier(node) && node.text === 'Agent' && !inType(node) &&
        !ts.isImportSpecifier(node.parent)) valid = false;
    if (ts.isIdentifier(node) && node.text === 'MemberStreamAgent') {
      if (node === classes[0].name) { /* declaration */ }
      else if (ts.isNewExpression(node.parent) && node.parent.expression === node && !node.parent.arguments?.length &&
          ts.isVariableDeclaration(node.parent.parent) && node.parent.parent.name.getText(source) === 'memberStreamAgent') instances++;
      else valid = false;
    }
    if (ts.isIdentifier(node) && node.text === 'memberStreamAgent') {
      if (ts.isVariableDeclaration(node.parent) && node.parent.name === node) { /* sole constructor above */ }
      else if (ts.isPropertyAssignment(node.parent) && node.parent.name.getText(source) === 'dispatcher' && node.parent.initializer === node) {
        let parent = node.parent;
        while (parent && !ts.isCallExpression(parent) && !ts.isFunctionDeclaration(parent)) parent = parent.parent;
        if (!parent || !ts.isCallExpression(parent) || parent.expression.getText(source) !== 'fetch') valid = false;
        else dispatchers++;
      } else valid = false;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return valid && instances === 1 && dispatchers === 1;
}

function imports(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const result = [];
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && !node.isTypeOnly && !node.importClause?.isTypeOnly) {
        const clause = node.importClause?.namedBindings ?? node.exportClause;
        const allType = clause && ts.isNamedImports(clause) && clause.elements.length > 0 && clause.elements.every(x => x.isTypeOnly);
        if (!allType) result.push({ specifier: node.moduleSpecifier.text, dynamic: false });
      }
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
      const arg = node.arguments[0];
      result.push({ specifier: arg && ts.isStringLiteralLike(arg) ? arg.text : undefined, dynamic: true });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return result;
}

const MOBILE = 'apps/mobile/sources/';
// Server-authored list caches still have one writer. Screens may send ordinary
// reads directly through the shared socket; no read capability is minted.
export function inspectSurfaceReadAuthority(file, text) {
  if (!file.startsWith(MOBILE) || !/\.[cm]?[jt]sx?$/.test(file)) return [];
  const owner = MOBILE + 'buzz/server-read-owner.ts';
  const transport = MOBILE + 'sync/transport/';
  const adapters = new Set([transport + 'monolith-operation.ts', transport + 'room-view-client.ts']);
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const errors = [];
  const deny = reason => errors.push(`${file}: server-indexed read authority ${reason}`);
  const resolve = value => value?.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(file), value)) : value?.replace(/^@\//, MOBILE);
  const guards = new Set(['isChatListView', 'needsList', 'savedList']);
  const restricted = new Set(['applyChatListDelta', 'chatListDeltaNeedsRead', 'keepUnavailableChatFacts', 'withoutCornerFacts', 'withCornerFacts']);
  const memberName = node => ts.isPropertyAccessExpression(node) ? node.name.text :
    ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined;
  const writerAliases = new Set();

  const publicReads = new Set(['ChatListKey', 'ChatListConsumer', 'ChatListHandle', 'acquireChatList',
    'liveChatList', 'chatListSnapshot', 'refreshChatList', 'resetChatListStoresForTest', 'readChatList',
    'loadNeedsYouList', 'loadSavedList', 'loadTrayList', 'seedNeedsYouList', 'forgetTray',
    'removeNeedsYou', 'holdNeedsYou', 'subscribeTrayGap', 'useTrayList', 'useNeedsYouCount',
    'acknowledgePaintedNeedsYou', 'hideSavedItems', 'revealSavedItems']);
  function visit(node) {
    if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name &&
        /(?:ChatListView|NeedsYouListResult|MessageBookmarkListResult)/.test((node.type ?? node.initializer?.type)?.getText(source) ?? ''))
      guards.add(node.name.getText(source));
    if (file === owner && node.parent === source) {
      if (ts.isExportDeclaration(node) || ts.isExportAssignment(node)) deny('implementation cannot be forwarded');
      if (node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        const names = ts.isVariableStatement(node) ? node.declarationList.declarations.map(item => item.name.getText(source)) : [node.name?.text];
        if (names.some(name => !publicReads.has(name))) deny('implementation must remain module-private');
      }
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      for (const element of node.importClause?.namedBindings?.elements ?? []) {
        if (guards.has((element.propertyName ?? element.name).text)) guards.add(element.name.text);
        if ((element.propertyName ?? element.name).text === 'readChatList' && /server-read-owner$/.test(resolve(node.moduleSpecifier.text) ?? '') && file !== MOBILE + 'buzz/chat-list-store.ts') deny('Forward gesture belongs to its declared transcript boundary');
        if (['applyChatListDelta', 'chatListDeltaNeedsRead', 'keepUnavailableChatFacts', 'withoutCornerFacts', 'withCornerFacts'].includes((element.propertyName ?? element.name).text) && file !== owner) deny('dispatch belongs to its owner');
      }
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier) &&
        /(?:read-authority|server-read-owner)$/.test(resolve(node.moduleSpecifier.text) ?? '') &&
        ![MOBILE + 'buzz/needs-you-store.ts', MOBILE + 'buzz/chat-list-store.ts'].includes(file) && !node.isTypeOnly)
      deny('cannot be forwarded');
    const member = memberName(node);
    if (file !== owner && (restricted.has(member) || ts.isBindingElement(node) && restricted.has((node.propertyName ?? node.name).getText(source))))
      deny('capability cannot be extracted outside its owner');
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier) &&
        /(?:monolith-operation|chat-list-delta)$/.test(resolve(node.moduleSpecifier.text) ?? '') && !node.isTypeOnly &&
        (!node.exportClause || !ts.isNamedExports(node.exportClause) || node.exportClause.elements.some(element => restricted.has((element.propertyName ?? element.name).text))))
      deny('wire/reducer capability cannot be forwarded');
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name) && ['write','publish','persist'].includes(memberName(node.initializer))) writerAliases.add(node.name.text);
      if (ts.isObjectBindingPattern(node.name)) for (const element of node.name.elements)
        if (['write','publish','persist'].includes((element.propertyName ?? element.name).getText(source))) writerAliases.add(element.name.getText(source));
    }
    if (file !== owner && ts.isCallExpression(node)) {
      const expression = node.expression;
      const member = ts.isPropertyAccessExpression(expression) ? expression.name.text :
        ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression) ? expression.argumentExpression.text : undefined;
      if ((['write','publish','persist'].includes(member) || ts.isIdentifier(expression) && writerAliases.has(expression.text)) &&
          (node.arguments.some(arg => ts.isIdentifier(arg) && guards.has(arg.text)) || /(?:ChatListView|NeedsYouListResult|MessageBookmarkListResult)|\/(?:needs-you|bookmarks|workspace\/:id\/chats)/.test(node.getText(source))))
        deny('committed surface writes belong to its owner');
    }
    // A capability-requiring adapter cannot become a generic exported executor.
    if (file === transport + 'monolith-operation.ts' && ts.isFunctionDeclaration(node) &&
        node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
        node.name?.text === 'executePhoneOperation') deny('raw executor must remain module-private');
    if (file === owner && ts.isModuleDeclaration(node) && node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))
      deny('implementation state must remain module-private');
    ts.forEachChild(node, visit);
  }
  visit(source);
  return errors;
}

export function inspectSource(file, text) {
  const errors = [];
  const inCore = file.startsWith('packages/net/src/');
  let hits = scanSource(file, text, LIBRARIES).filter(hit => !hit.kind.startsWith('origin:'));
  // Rust HTTP clients are native leaves too; imports remain explicit inventory.
  if (file.endsWith('.rs')) {
    for (const match of text.matchAll(/\b(?:reqwest|hyper|TcpStream|UdpSocket|tungstenite)\b/g))
      hits.push({ kind: 'rust-network', line: text.slice(0, match.index).split('\n').length });
  }
  if (/\.[cm]?[jt]sx?$/.test(file)) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    if (configuredMcpDispatcher(file, source)) hits = hits.filter(hit => hit.kind !== 'import:undici');
    const commandOwners = ['apps/mobile/sources/buzz/command-owner.ts', 'apps/mobile/sources/sync/transport/live-connection.ts'];
    function commandAccess(node) {
      const member = ts.isPropertyAccessExpression(node) ? node.name.text
        : ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)
          ? node.argumentExpression.text : undefined;
      if (member === 'requestCommand' && !commandOwners.includes(file))
        errors.push(`${file}: durable command executor belongs to the persisted intent owner`);
      ts.forEachChild(node, commandAccess);
    }
    commandAccess(source);
    errors.push(...inspectSurfaceReadAuthority(file, text));
    for (const entry of imports(file, text)) {
      if (entry.dynamic && !entry.specifier) hits.push({ kind: 'computed-import', line: 1 });
      const target = entry.specifier?.startsWith('.')
        ? path.posix.normalize(path.posix.join(path.posix.dirname(file), entry.specifier))
        : entry.specifier;
      if (inCore) {
        if (entry.dynamic || !target?.startsWith('packages/net/src/'))
          errors.push(`${file}: shared router core cannot load ${entry.specifier ?? 'computed module'}`);
        // A public barrel must never export private runtime factories, even indirectly.
        if (PUBLIC_ENTRIES.includes(file) && target?.includes('/private/'))
          errors.push(`${file}: public API exposes private owner machinery`);
      } else if (target === '@beeline/net/helper-turn-codecs' && ['apps/body/src/helper-turn-channel.ts', 'apps/server/src/daemon-live.ts'].includes(file)) {
        // Closed claim/receipt/ack controls belong only to the existing machine adapters.
      } else if (target === '@beeline/net/helper-activation-codecs' && ['apps/body/src/helper-activation-channel.ts', 'apps/server/src/daemon-live.ts'].includes(file)) {
        // Closed activation codec belongs only to the owned machine socket adapters.
      } else if (target === '@beeline/net/helper-codecs' && ['apps/body/src/helper-usage-channel.ts', 'apps/server/src/daemon-live.ts'].includes(file)) {
        // Closed usage codecs belong only to the existing machine socket adapters.
      } else if (target === '@beeline/net/owner' && ['apps/mobile/sources/buzz/command-owner.ts'].includes(file)) {
        // Exact trusted navigation and persisted-intent owners; no feature imports.
      } else if (target?.startsWith('@beeline/net/') || target?.startsWith('packages/net/')) {
        // Add exact production owners only with their M2/M3
        // proofs rather than authorizing a directory of feature callers.
        errors.push(`${file}: private router import ${entry.specifier}`);
      }
    }
  }
  if (inCore && hits.length) errors.push(`${file}: router core must be transport-free (${hits.map(x => x.kind).join(', ')})`);
  return { hits, errors };
}

export function sourceFiles(root) {
  const files = new Set();
  function walk(relative) {
    let entries;
    try { entries = readdirSync(path.join(root, relative), { withFileTypes: true }); }
    catch (error) {
      if (error.code === 'ENOENT') return;
      if (error.code === 'ENOTDIR') { if (SOURCE.test(relative) && !TEST.test(relative)) files.add(relative); return; }
      throw error;
    }
    for (const entry of entries) {
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) { if (!SKIP.has(entry.name)) walk(file); }
      else if (SOURCE.test(file) && !TEST.test(file)) files.add(file);
    }
  }
  for (const start of ROOTS) walk(start);
  return [...files].sort();
}

export function scanRouterTree(root) {
  const sites = new Map();
  const errors = [];
  const files = sourceFiles(root);
  const graph = new Map();
  for (const file of files) {
    const text = readFileSync(path.join(root, file), 'utf8');
    if (file.startsWith('packages/net/src/')) graph.set(file, imports(file, text));
    const result = inspectSource(file, text);
    errors.push(...result.errors);
    for (const hit of result.hits) {
      const id = `${file}::${hit.kind}`;
      const entry = sites.get(id) ?? { id, file, kind: hit.kind, count: 0, compatibility: 'legacy-only',
        phase: file.startsWith('apps/body/') ? 'M5' : file.startsWith('apps/server/') ? 'M2' : 'M4' };
      entry.count++;
      sites.set(id, entry);
    }
  }
  // A production import cannot hide transport in a skipped test-named file.
  for (const [file, edges] of graph) {
    for (const entry of edges) {
      if (!entry.specifier?.startsWith('.')) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), entry.specifier)).replace(/\.js$/, '.ts');
      if (!graph.has(target) && target.startsWith('packages/net/src/')) {
        let text;
        try { text = readFileSync(path.join(root, target), 'utf8'); }
        catch { errors.push(`${file}: unresolved core import ${entry.specifier}`); continue; }
        graph.set(target, imports(target, text));
        errors.push(...inspectSource(target, text).errors);
      }
    }
  }
  // Follow runtime imports/reexports from the public barrel, not just direct
  // exports: a harmless-looking proxy must not expose minting machinery.
  const seen = new Set();
  function publicReach(file) {
    if (seen.has(file)) return;
    seen.add(file);
    if (file.includes('/private/')) errors.push(`${file}: private owner reachable from public API`);
    for (const entry of graph.get(file) ?? []) {
      if (!entry.specifier?.startsWith('.')) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), entry.specifier));
      publicReach(target.replace(/\.js$/, '.ts'));
    }
  }
  for (const entry of PUBLIC_ENTRIES) publicReach(entry);
  return { sites, errors };
}

export function judgeInventory(sites, inventory, baseline) {
  const errors = [];
  const entries = new Map();
  for (const entry of inventory.entries ?? []) {
    if (entries.has(entry.id)) errors.push(`duplicate migration entry: ${entry.id}`);
    entries.set(entry.id, entry);
    if (entry.id !== `${entry.file}::${entry.kind}` || !Number.isInteger(entry.count) || entry.count < 1 ||
      entry.compatibility !== 'legacy-only' || !['M2', 'M4', 'M5'].includes(entry.phase))
      errors.push(`invalid migration entry: ${entry.id}`);
    if (sites.get(entry.id)?.count !== entry.count) errors.push(`stale migration count: ${entry.id}`);
  }
  for (const [id, site] of sites) if (!entries.has(id)) errors.push(`undeclared network boundary: ${id} (${site.count})`);
  if (baseline) {
    const before = new Map(baseline.entries.map(entry => [entry.id, entry]));
    for (const entry of entries.values()) {
      const old = before.get(entry.id);
      if (!old || entry.count > old.count) errors.push(`migration debt cannot grow: ${entry.id}`);
    }
  }
  return errors;
}

export function baselineInventory(root, base, currentSites) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['rev-parse', '--verify', `${base}^{commit}`]); // invalid/unfetched base fails closed
  const present = git(['ls-tree', '--name-only', base, '--', INVENTORY]).trim();
  if (present) return JSON.parse(git(['show', `${base}:${INVENTORY}`]));
  // Bootstrap: existing unchanged files are from the trusted base. For every
  // changed/new file use its BASE source, so adding the inventory cannot launder
  // new network sites in the same PR. Deleted files cannot increase today's debt.
  const entries = new Map(currentSites);
  const changed = git(['diff', '--name-only', base, '--', ...ROOTS]).trim().split('\n').filter(Boolean);
  const tracked = new Set(git(['ls-tree', '-r', '--name-only', base, '--', ...ROOTS]).trim().split('\n'));
  for (const file of sourceFiles(root)) if (!tracked.has(file) && !changed.includes(file)) changed.push(file);
  for (const file of changed) {
    for (const [id, site] of entries) if (site.file === file) entries.delete(id);
    if (!tracked.has(file) || !SOURCE.test(file) || TEST.test(file)) continue;
    for (const hit of inspectSource(file, git(['show', `${base}:${file}`])).hits) {
      const id = `${file}::${hit.kind}`;
      const entry = entries.get(id) ?? { id, count: 0 };
      entry.count++;
      entries.set(id, entry);
    }
  }
  return { entries: [...entries.values()] };
}
