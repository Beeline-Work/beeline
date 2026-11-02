// Additive gate: the original phone scanner and its manifest stay authoritative.
import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import ts from 'typescript';
import { scanSource, NETWORK_LIBRARIES } from './phone-network-channels.mjs';

export const INVENTORY = 'packages/net/migration-sites.json';
const ROOTS = ['apps/server/src', 'apps/body/src', 'apps/api/src', 'apps/auth/src', 'apps/mobile/sources', 'apps/mobile/modules',
  'apps/mobile/index.ts', 'apps/mobile/src-tauri/src', 'packages'];
const PUBLIC_ENTRIES = ['packages/net/src/index.ts', 'packages/net/src/phone-inputs.ts', 'packages/net/src/helper-codecs.ts', 'packages/net/src/helper-activation-codecs.ts', 'packages/net/src/helper-turn-codecs.ts'];
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
const LIVE_BRIDGE = MOBILE + 'sync/transport/live-connection.ts';
const OWNER_CALLERS = {
  routerOwnerUsageProfile: ['app/(app)/beeline/agent-profile.tsx', 'app/(app)/beeline/chat/_chat-surface.tsx'],
  routerOwnerArtifactViewport: ['app/(app)/beeline/chat/_chat-surface.tsx'],
  routerOwnerArtifactAction: ['components/buzz/ArtifactCard.tsx', 'components/buzz/RunnableArtifact.tsx',
    'app/(app)/beeline/chat/RoomMessageVariants.tsx', 'buzz/picture-actions.ts', 'buzz/artifact-link.ts'],
  routerOwnerNavigation: ['buzz/use-router-navigation.ts'],
  routerOwnerListPanel: ['components/SidebarNavigator.tsx'],
  admitRouterPreparedMessage: ['buzz/command-message-gesture.ts'],
  admitRouterScheduledStop: ['buzz/router-scheduled-work.ts'],
  acquireRouterSavedContinuation: ['buzz/router-tray.ts'],
  admitRouterTrayCommand: ['buzz/router-tray.ts'],
  admitRouterTrayPaint: ['buzz/router-tray.ts'],
  routerOwnerCapabilities: ['sync/transport/live-connection.ts'],
  routerOwnerNegotiated: ['sync/transport/live-connection.ts'],
  routerOwnerDisconnected: ['sync/transport/live-connection.ts'],
  routerOwnerReceive: ['sync/transport/live-connection.ts'],
  retryRouterLane: ['buzz/router-scheduled-work.ts', 'buzz/router-tray.ts', 'app/(app)/beeline/channels.tsx', 'app/(app)/beeline/chat/useRoomSurfaceSession.ts'],
  acquireRouterLane: ['buzz/router-scheduled-work.ts', 'buzz/router-tray.ts', 'app/(app)/beeline/chat/useRoomSurfaceSession.ts', 'buzz/router-chat-list.ts', 'buzz/needs-you-store.ts'],
};
const OWNER_READS = new Set(['routerFamilyMode', 'routerLaneSnapshot', 'subscribeRouterOwner']);
function inspectOwnerAccess(file, source, errors) {
  const allowed = name => OWNER_READS.has(name) || (Object.hasOwn(OWNER_CALLERS, name) && OWNER_CALLERS[name].some(caller => MOBILE + caller === file));
  const ownerModule = specifier => {
    if (!specifier || !ts.isStringLiteralLike(specifier)) return false;
    const target = specifier.text.startsWith('.')
      ? path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier.text)) : specifier.text;
    return target.replace(/\.[cm]?[jt]sx?$/, '') === MOBILE + 'buzz/router-owner' || target === '@/buzz/router-owner';
  };
  const reject = name => errors.push(`${file}: router owner authority ${name} belongs to its declared UI or socket boundary`);
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && ownerModule(node.moduleSpecifier) &&
        !node.isTypeOnly && !node.importClause?.isTypeOnly) {
      const names = node.importClause?.namedBindings ?? node.exportClause;
      // Re-exports and namespace/default imports could forward minting authority.
      if (ts.isExportDeclaration(node) || node.importClause?.name || !names || !ts.isNamedImports(names)) reject('module forwarding');
      else for (const item of names.elements) if (!item.isTypeOnly && !allowed((item.propertyName ?? item.name).text))
        reject((item.propertyName ?? item.name).text);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        ts.isIdentifier(node.expression) && node.expression.text === 'require') && ownerModule(node.arguments[0]) && file !== LIVE_BRIDGE)
      reject('dynamic module');
    const member = ts.isPropertyAccessExpression(node) ? node.name.text
      : ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)
        ? node.argumentExpression.text : undefined;
    if (member && Object.hasOwn(OWNER_CALLERS, member) && !allowed(member)) reject(member);
    ts.forEachChild(node, visit);
  }
  visit(source);
}

// Gesture wrappers retain the same exact caller boundary as the owner mint.
// Observing a hook cannot be used to re-export its command/paint authority.
function inspectGestureWrappers(file,source,errors){
  const modules={
    'buzz/router-tray':{'useRoutedTray':['app/(app)/beeline/tray.tsx'],
      'prepareTrayCommand':['app/(app)/beeline/tray.tsx'],'acknowledgeRoutedTrayPaint':['app/(app)/beeline/tray.tsx']},
    'buzz/router-scheduled-work':{'useRoutedScheduledWork':['buzz/scheduled-work.ts'],'prepareScheduledStop':['buzz/scheduled-work.ts']},
  };
  const resolve=specifier=>{
    if(!specifier||!ts.isStringLiteralLike(specifier))return;
    const target=(specifier.text.startsWith('.')?path.posix.normalize(path.posix.join(path.posix.dirname(file),specifier.text)):
      specifier.text.replace(/^@\//,MOBILE)).replace(/\.[cm]?[jt]sx?$/,'');
    return Object.keys(modules).find(name=>target===MOBILE+name);
  };
  const deny=()=>errors.push(`${file}: gesture wrapper authority belongs to its declared UI boundary`);
  function visit(node){
    if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&!node.isTypeOnly&&!node.importClause?.isTypeOnly){
      const module=resolve(node.moduleSpecifier);
      if(module){
        const names=node.importClause?.namedBindings;
        if(ts.isExportDeclaration(node)||node.importClause?.name||!names||!ts.isNamedImports(names))deny();
        else for(const item of names.elements)if(!item.isTypeOnly){
          const allowed=modules[module][(item.propertyName??item.name).text];
          if(!allowed?.some(caller=>MOBILE+caller===file))deny();
        }
      }
    }
    if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||ts.isIdentifier(node.expression)&&node.expression.text==='require')&&resolve(node.arguments[0]))deny();
    ts.forEachChild(node,visit);
  }
  visit(source);
}

// Installing a connection adapter or an authority receipt is trusted owner work.
// Feature consumers may observe metadata/cells, but cannot replace their executor.
function inspectConnectionOwners(file, source, errors) {
  const modules = {
    'media-cache-connection': new Set(['installMediaCacheConnection', 'installLegacyMediaCacheConnection',
      'suspendMediaCacheConnection', 'receiveMediaAuthorityRemoval', 'invalidateMediaCacheDemand']),
    'agent-usage-cell': new Set(['installUsageCellConnection', 'suspendUsageCellConnection', 'receiveUsageCell', 'setUsageCellProfile']),
  };
  if (file === MOBILE + 'buzz/router-owner.ts') return;
  const target = specifier => {
    if (!specifier || !ts.isStringLiteralLike(specifier)) return;
    const resolved = specifier.text.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier.text))
      : specifier.text.replace(/^@\//, MOBILE);
    return Object.keys(modules).find(name => resolved.replace(/\.[cm]?[jt]sx?$/, '') === MOBILE + 'buzz/' + name);
  };
  const deny = () => errors.push(`${file}: connection installation belongs to the trusted router owner`);
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && !node.isTypeOnly && !node.importClause?.isTypeOnly) {
      const module = target(node.moduleSpecifier);
      if (module) {
        const names = node.importClause?.namedBindings;
        if (ts.isExportDeclaration(node) || node.importClause?.name || !names || !ts.isNamedImports(names)) deny();
        else for (const item of names.elements) if (!item.isTypeOnly && modules[module].has((item.propertyName ?? item.name).text)) deny();
      }
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        ts.isIdentifier(node.expression) && node.expression.text === 'require') && target(node.arguments[0])) deny();
    ts.forEachChild(node, visit);
  }
  visit(source);
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
    inspectOwnerAccess(file, source, errors);
    inspectGestureWrappers(file, source, errors);
    inspectConnectionOwners(file, source, errors);
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
      } else if (target === '@beeline/net/owner' && ['apps/mobile/sources/buzz/router-owner.ts', 'apps/mobile/sources/buzz/command-owner.ts'].includes(file)) {
        // Exact trusted navigation and persisted-intent owners; no feature imports.
      } else if (target?.startsWith('@beeline/net/') && target !== '@beeline/net/phone-inputs' || target?.startsWith('packages/net/')) {
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
