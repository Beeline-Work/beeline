import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';

const mobile = resolve(__dirname, '../..');

// Native packages added after supported store binaries need an explicit
// capability check before evaluation. Extend this map for future additions.
const optionalNativeModules: Readonly<Record<string, string>> = {
  '@react-native-community/netinfo': 'RNCNetInfo',
};

function unparen(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) ? unparen(node.expression) : node;
}

function isMember(node: ts.Expression, object: string, property: string): boolean {
  node = unparen(node);
  return ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) &&
    node.expression.text === object && node.name.text === property;
}

function rejectsMissingNative(node: ts.Expression, capability: string): boolean {
  node = unparen(node);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken)
    return isMember(node.operand, 'NativeModules', capability);
  if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) return false;
  const excludesWeb = (value: ts.Expression) => {
    value = unparen(value);
    return ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
      isMember(value.left, 'Platform', 'OS') && ts.isStringLiteral(value.right) && value.right.text === 'web';
  };
  return (excludesWeb(node.left) && rejectsMissingNative(node.right, capability)) ||
    (excludesWeb(node.right) && rejectsMissingNative(node.left, capability));
}

function hasPrecedingCapabilityGuard(node: ts.Node, capability: string): boolean {
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    // A hoisted callback may run before a guard in its enclosing function.
    if (ts.isFunctionLike(parent)) break;
    if (!ts.isBlock(parent)) continue;
    const index = parent.statements.indexOf(child as ts.Statement);
    for (const statement of parent.statements.slice(0, Math.max(0, index))) {
      if (!ts.isIfStatement(statement) || !rejectsMissingNative(statement.expression, capability)) continue;
      const branch = statement.thenStatement;
      const exit = ts.isBlock(branch) ? branch.statements.at(-1) : branch;
      if (exit && (ts.isReturnStatement(exit) || ts.isThrowStatement(exit))) return true;
    }
  }
  return false;
}

function unsafeNativeImports(source: ts.SourceFile): ts.Node[] {
  const violations: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    const call = ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'));
    const declaration = (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) ||
      (ts.isExportDeclaration(node) && !node.isTypeOnly);
    const target = call ? node.arguments[0] : declaration ? node.moduleSpecifier : undefined;
    if (target && ts.isStringLiteralLike(target)) {
      const capability = Object.entries(optionalNativeModules)
        .find(([name]) => target.text === name || target.text.startsWith(name + '/'))?.[1];
      if ((target.text === 'react-native' && call && node.expression.kind === ts.SyntaxKind.ImportKeyword) ||
          (capability && (declaration || !hasPrecedingCapabilityGuard(node, capability)))) violations.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

it.each([
  ['caught import', "void import('@react-native-community/netinfo').catch(() => undefined)", 1],
  ['comment', "// NativeModules.RNCNetInfo is optional\nvoid import('@react-native-community/netinfo')", 1],
  ['late check', "void import('@react-native-community/netinfo'); if (!NativeModules.RNCNetInfo) return", 1],
  ['wrong capability', "if (!NativeModules.OtherModule) return; void import('@react-native-community/netinfo')", 1],
  ['one platform only', "if (Platform.OS === 'android' && !NativeModules.RNCNetInfo) return; void import('@react-native-community/netinfo')", 1],
  ['conditional exit', "if (!NativeModules.RNCNetInfo) { if (ready) return; } void import('@react-native-community/netinfo')", 1],
  ['hoisted callback', "load(); if (!NativeModules.RNCNetInfo) return; function load() { void import('@react-native-community/netinfo'); }", 1],
  ['static import', "import NetInfo from '@react-native-community/netinfo'", 1],
  ['capability check', "if (!NativeModules.RNCNetInfo) return; void import('@react-native-community/netinfo')", 0],
  ['web exception', "if (Platform.OS !== 'web' && !NativeModules.RNCNetInfo) return () => {}; void import('@react-native-community/netinfo')", 0],
  ['guarded require', "if (!NativeModules.RNCNetInfo) return; require('@react-native-community/netinfo')", 0],
])('checks optional native import ordering: %s', (_name, body, count) => {
  const source = ts.createSourceFile('fixture.ts', `function subscribe() { ${body} }`, ts.ScriptTarget.Latest, true);
  expect(unsafeNativeImports(source)).toHaveLength(count);
});

it('demonstrates why Metro namespace imports cannot touch the native barrel', () => {
  const runtime: Record<string, any> = { __DEV__: false, __METRO_GLOBAL_PREFIX__: '', console };
  runtime.global = runtime;
  runInNewContext(readFileSync(join(mobile, 'node_modules/metro-runtime/src/polyfills/require.js'), 'utf8'), runtime);
  const linking = {};
  const legacy = () => { throw new Error('PushNotificationManager is absent'); };
  runtime.__d((_global: unknown, _require: unknown, _default: unknown, _all: unknown, module: any) => {
    module.exports = Object.defineProperty({ Linking: linking }, 'PushNotificationIOS', {
      enumerable: true, get: legacy,
    });
  }, 1, []);
  expect(runtime.__r(1).Linking).toBe(linking);
  // Metro's production importAll reads the getter, even for import().then(({ Linking }) => ...).
  expect(() => runtime.__r.importAll(1)).toThrow('PushNotificationManager is absent');
});

it('keeps production native imports compatible with installed runtimes', () => {
  const violations: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') walk(file);
        continue;
      }
      if (!/\.[jt]sx?$/.test(file) || /\.(test|spec)\./.test(file) || file.endsWith('.d.ts')) continue;
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      for (const node of unsafeNativeImports(source)) {
        violations.push(file.slice(mobile.length + 1) + ':' +
          (source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1));
      }
    }
  };
  walk(join(mobile, 'sources'));
  expect(violations, 'Use named React Native imports; check optional native capabilities before evaluating their packages. A rejected import is already fatal in Metro.').toEqual([]);
});
