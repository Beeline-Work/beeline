// Reproduction WEB-OUTBOX-3446: run the affected export's layout and Metro loader.
// Inputs are private Sentry artifact downloads, never committed to the repository.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const [mainPath, outboxPath, runtimePath, layoutPath] = process.argv.slice(2);
if (!runtimePath) throw new Error('Usage: node scripts/outbox-startup-bundle-proof.mjs <release-index.js> <release-outbox.js> <metro-runtime.js>');
const main = readFileSync(mainPath, 'utf8');
const chunk = readFileSync(outboxPath, 'utf8');
const runtime = readFileSync(runtimePath, 'utf8');
const layoutSource = readFileSync(layoutPath ?? new URL('../sources/app/(app)/_layout.tsx', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('layout.tsx', layoutSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const includesOutbox = parsed.statements.some(node => ts.isImportDeclaration(node) && node.moduleSpecifier.text === '@/buzz/message-outbox-runtime');
const fixed = ts.transpileModule(layoutSource, {
  // Preserve Metro's separate loading boundary if the source regresses to import().
  transformers: { before: [context => root => {
    const visit = node => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        return ts.factory.createCallExpression(ts.factory.createIdentifier('__loadOutboxChunk'), undefined, node.arguments);
      }
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitNode(root, visit);
  }] },
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const definitions = new Map();
const capture = vm.createContext({ __d: (factory, id, deps) => definitions.set(id, { factory, deps }), __r: () => {} });
vm.runInContext(main, capture);
assert.equal(definitions.get(1944).deps[4], 3446);
assert.match(definitions.get(1944).deps.paths[3446], /message-outbox-runtime-1055faba/);

async function run(mode) {
  const effects = [];
  let restored = 0;
  let lazyRequests = 0;
  const jsx = { jsx: () => null, jsxs: () => null };
  const react = { useEffect: effect => effects.push(effect) };
  const stack = Object.assign(() => null, { Screen: () => null });
  const connection = { diagnostics: () => ({ state: 1 }), subscribeConnected: () => () => {}, subscribeDisconnected: () => () => {}, register: async () => () => {} };
  const owner = { restore: async () => { restored++; }, connectionChanged: async () => {} };
  const mocks = new Map([
    [1945, {}], [85, react], [751, {}], [835, jsx],
    [2259, { useIsDesktop: () => false }],
    [1846, { useUnistyles: () => ({ theme: { colors: { groupped: {} }, buzz: {} } }) }],
    [2215, { View: () => null }], [2269, { Stack: stack }],
    [2287, { statusBarStyleForTheme: () => 'light' }], [2291, { CornerOpenToast: () => null }],
    [1584, { clientResetGeneration: () => 0, subscribeClientReset: () => {} }],
    [1593, { loadBuzzIdentity: async () => ({ publicKey: 'test' }) }],
    [2526, { MonolithRigTransport: class {} }], [1725, { sharedLiveConnection: () => connection }],
    [1733, { configureMessageOutboxDelivery: () => {}, getMessageOutbox: () => owner }],
    [2527, { MonolithPhoneOperationError: class extends Error {} }],
    [1585, { getBuzzRuntimeConfig: () => ({ monolithUrl: 'https://example.invalid' }) }],
    [2743, { observeMessageOutbox: () => () => {} }],
  ]);
  const context = vm.createContext({ console });
  vm.runInContext(runtime, context);
  for (const [id, value] of mocks) context.__d((_g, _r, _i, _a, module) => { module.exports = value; }, id, []);
  for (const id of [1590, 1591, 1944]) {
    const { factory, deps } = definitions.get(id);
    vm.runInContext(`__d(${factory.toString()}, ${id}, ${JSON.stringify(deps)})`, context);
  }
  context.__loadBundleAsync = async () => {
    lazyRequests++;
    // Expo's script onload can settle without the requested module registering.
    if (mode === 'baseline-valid-chunk') vm.runInContext(chunk, context);
  };
  let layout;
  if (mode.startsWith('baseline')) layout = context.__r(1944).default;
  else {
    // A static import includes the required runtime in the boot bundle.
    if (includesOutbox) vm.runInContext(chunk, context);
    const exports = {};
    const aliases = {
      'expo-router': { Stack: stack }, 'react-native-reanimated': {}, react,
      'react-native': { View: () => null }, 'react/jsx-runtime': jsx,
      'react-native-unistyles': mocks.get(1846),
      '@/components/StatusBarProvider': mocks.get(2287),
      '@/components/buzz/CornerOpenToast': mocks.get(2291),
      '@/utils/responsive': mocks.get(2259),
      '@/buzz/message-outbox-runtime': includesOutbox ? context.__r(3446) : undefined,
    };
    vm.runInNewContext(fixed, { exports, __loadOutboxChunk: () => context.__r(1590)(3446, definitions.get(1944).deps.paths), require: name => {
      assert.ok(Object.hasOwn(aliases, name), `Unexpected layout dependency: ${name}`);
      return aliases[name];
    } });
    layout = exports.default;
  }
  layout();
  const rejections = [];
  const onUnhandled = reason => rejections.push(reason.message);
  process.on('unhandledRejection', onUnhandled);
  try {
    effects.forEach(effect => effect());
    await new Promise(resolve => setTimeout(resolve, 20));
  } finally { process.off('unhandledRejection', onUnhandled); }
  return { restored, lazyRequests, rejections };
}
assert.deepEqual(await run('baseline-missing-chunk'), { restored: 0, lazyRequests: 1, rejections: ['Requiring unknown module "3446".'] });
assert.deepEqual(await run('baseline-valid-chunk'), { restored: 1, lazyRequests: 1, rejections: [] });
assert.deepEqual(await run('fixed'), { restored: 1, lazyRequests: 0, rejections: [] });
console.log('WEB-OUTBOX-3446: affected layout fails when its chunk does not register; valid chunk restores outbox; current layout restores outbox without any lazy request or rejection.');
