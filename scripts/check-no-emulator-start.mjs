import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** Follow local constants so moving a boot command out of spawn's argv cannot hide it. */
export function emulatorStarts(file, text) {
  if (file.endsWith('.sh'))
    return /(?:^|[;&|\n])\s*(?:(?:exec|setsid|nohup)\s+)?(?:[^\s]*\/)?(?:emulator|qemu-system-[^\s]+)\s/m.test(text)
      ? [`${file}: helper must never start an emulator process`] : [];
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const bindings = new Map();
  const launchers = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
  function collect(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      bindings.set(node.name.text, node.initializer);
    if (ts.isImportSpecifier(node) && launchers.has((node.propertyName ?? node.name).text))
      launchers.add(node.name.text);
    ts.forEachChild(node, collect);
  }
  collect(tree);
  let changed;
  do {
    changed = false;
    for (const [name, node] of bindings) {
      const target = ts.isIdentifier(node) ? node.text : ts.isPropertyAccessExpression(node) ? node.name.text : undefined;
      const wrapsLauncher = ts.isCallExpression(node) && node.arguments.some(arg => ts.isIdentifier(arg) && launchers.has(arg.text));
      if (!launchers.has(name) && (launchers.has(target) || wrapsLauncher)) {
        launchers.add(name);
        changed = true;
      }
    }
  } while (changed);
  const marker = /emulator|qemu-system|(?:^|[\s'"`])-avd(?:[\s'"`]|$)|avdmanager[\s\S]*create/i;
  const inspected = new Map();
  function referencesEmulator(node, seen = new Set()) {
    if (inspected.has(node)) return inspected.get(node);
    if (marker.test(node.getText(tree))) return true;
    if (ts.isIdentifier(node) && bindings.has(node.text) && !seen.has(node.text))
      return referencesEmulator(bindings.get(node.text), new Set([...seen, node.text]));
    let found = false;
    ts.forEachChild(node, child => { if (referencesEmulator(child, seen)) found = true; });
    inspected.set(node, found);
    return found;
  }
  const errors = [];
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const name = ts.isIdentifier(node.expression) ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : '';
      if (launchers.has(name)) {
        if (node.arguments.some(arg => referencesEmulator(arg)))
          errors.push(`${file}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}: helper must never start an emulator process`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return errors;
}

export function checkNoEmulatorStart(root) {
  const errors = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.git'].includes(entry.name)) continue;
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:[cm]?[jt]sx?|sh)$/.test(path) && !/\.(test|spec)\.[^.]+$/.test(path))
        errors.push(...emulatorStarts(path, readFileSync(path, 'utf8')));
    }
  }
  walk(resolve(root, 'apps/body'));
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkNoEmulatorStart(fileURLToPath(new URL('..', import.meta.url)));
  for (const error of errors) console.error(error);
  if (errors.length) process.exitCode = 1;
  else console.log('Helper emulator process guard passed.');
}
