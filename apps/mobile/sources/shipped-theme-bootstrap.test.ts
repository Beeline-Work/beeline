import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const mobile = resolve(import.meta.dirname, '..');
const babel = require('@babel/core');
const inlineRequires = require('metro-transform-plugins').inlineRequiresPlugin;

function transformEntry() {
  const filename = resolve(mobile, 'index.ts');
  const compiled = babel.transformSync(readFileSync(filename, 'utf8'), {
    filename, cwd: mobile,
    caller: { name: 'metro', platform: 'android', isDev: false, supportsStaticESM: false },
  });
  return babel.transformSync(compiled.code, {
    configFile: false, babelrc: false, plugins: [inlineRequires],
  }).code;
}

function localModule(from: string, id: string): string | undefined {
  const base = id.startsWith('@/') ? resolve(mobile, 'sources', id.slice(2))
    : id.startsWith('.') ? resolve(dirname(from), id) : undefined;
  if (!base) return undefined;
  return ['', '.android.ts', '.android.tsx', '.native.ts', '.native.tsx', '.ts', '.tsx', '.js', '/index.ts', '/index.tsx']
    .map(suffix => base + suffix).find(path => existsSync(path) && /\.[jt]sx?$/.test(path));
}

function applicationGraph(roots: string[]) {
  const seen = new Set<string>();
  const visitFile = (path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    const ast = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      let id: string | undefined;
      if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier))
        id = node.moduleSpecifier.text;
      if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
        id = node.moduleSpecifier.text;
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(ast) === 'require')
        && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) id = node.arguments[0].text;
      if (id) { const dependency = localModule(path, id); if (dependency) visitFile(dependency); }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  };
  roots.forEach(root => visitFile(resolve(mobile, root)));
  return [...seen];
}

describe('shipped Android theme startup', () => {
  it('keeps the shared entry configuration eager before Router and task installation', () => {
    const events: string[] = [];
    let selected = false;
    runInNewContext(transformEntry(), { require: (id: string) => {
      if (id.startsWith('@babel/runtime/')) return require(id);
      events.push(id);
      if (id === './sources/unistyles') selected = true;
      if (id === 'expo-router/entry') expect(selected).toBe(true);
      if (id.endsWith('notification-action-runtime')) return { installNotificationActions: () => expect(selected).toBe(true) };
      if (id.endsWith('read-clear-runtime')) return { installReadClearTask: () => expect(selected).toBe(true) };
      return {};
    } });
    expect(events).toContain('./sources/unistyles');
    expect(events).toContain('expo-router/entry');
  });

  it('has no themed application stylesheet reachable from pre-theme bootstrap or action tasks', () => {
    const graph = applicationGraph([
      'sources/buzz/sentry.ts', 'sources/polyfills/screenOrientation.ts', 'sources/polyfills/webViewport.ts',
      'sources/push/early-room-prefetch-bootstrap.ts', 'sources/push/notification-action-runtime.ts',
      'sources/push/read-clear-runtime.ts',
    ]);
    expect(graph.length).toBeGreaterThan(20);
    const themed = graph.filter(file => /['"]react-native-unistyles(?:\/[^'"]*)?['"]|StyleSheet\s*\.\s*create\s*\(|useUnistyles\s*\(/.test(readFileSync(file, 'utf8')));
    expect(themed).toEqual([]);
  });
});
