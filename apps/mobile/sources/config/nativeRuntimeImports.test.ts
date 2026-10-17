import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';

const mobile = resolve(__dirname, '../..');

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

it('keeps production dynamic imports away from the React Native barrel', () => {
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
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]) &&
          node.arguments[0].text === 'react-native') {
          violations.push(file.slice(mobile.length + 1) + ':' +
            (source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1));
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  };
  walk(join(mobile, 'sources'));
  expect(violations, 'Use named imports or a direct require; Metro enumerates optional native getters for import().').toEqual([]);
});
