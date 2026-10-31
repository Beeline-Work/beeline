// Do not delete, disable or modify this guard or its list without lunchboxfortwo's express command.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const failure = 'Changed corner state machine. Only lunchboxfortwo can approve corner state changes. Revert it, or get lunchboxfortwo\'s express command and update apps/server/corner-state.lock.jsonc.';
type Entry = { file: string; declaration: string; sha256: string };
const printer = ts.createPrinter({ removeComments: true });
const lockPath = resolve(root, 'apps/server/corner-state.lock.jsonc');
const parsedLock = ts.parseConfigFileTextToJson(lockPath, readFileSync(lockPath, 'utf8'));
if (parsedLock.error) throw new Error(failure);
const locked = parsedLock.config.entries as Entry[];

/** Print the declaration's AST without comments, then retain tokens rather than layout. */
function digest(source: string, name: string): string {
  const file = ts.createSourceFile('locked.ts', source, ts.ScriptTarget.Latest, true);
  const declarations = file.statements.filter(node =>
    (ts.isFunctionDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.name?.text === name);
  if (declarations.length !== 1) throw new Error(`${failure}\nMissing or duplicate declaration: ${name}`);
  const printed = printer.printNode(ts.EmitHint.Unspecified, declarations[0]!, file);
  const canonical = ts.createSourceFile('canonical.ts', printed, ts.ScriptTarget.Latest, true);
  const tokens: Array<[number, string]> = [];
  const visit = (node: ts.Node) => {
    const children = node.getChildren(canonical);
    if (children.length) children.forEach(visit);
    else tokens.push([node.kind, node.getText(canonical)]);
  };
  visit(canonical);
  return createHash('sha256').update(JSON.stringify(tokens)).digest('hex');
}

function enforce(entries: readonly Entry[], files: ReadonlyMap<string, string>): void {
  if (!entries.length) throw new Error(failure);
  for (const entry of entries) {
    const source = files.get(entry.file);
    if (source === undefined || digest(source, entry.declaration) !== entry.sha256)
      throw new Error(`${failure}\n${entry.file}: ${entry.declaration}`);
  }
}

const files = new Map([...new Set(locked.map(entry => entry.file))]
  .map(file => [file, readFileSync(resolve(root, file), 'utf8')]));

it('LOCK-1: keeps the owner-approved corner state declarations unchanged', () => {
  enforce(locked, files);
});

function fixture(name: string): { entry: Entry; source: string } {
  const entry = locked.find(entry => entry.declaration === name)!;
  return { entry, source: files.get(entry.file)! };
}

it('LOCK-1: rejects a changed precedence line', () => {
  const { entry, source } = fixture('deriveCornerState');
  const changed = source.replace('if (facts.turnRunning)', 'if (facts.reviewerActive)');
  expect(changed).not.toBe(source);
  expect(() => enforce([entry], new Map([[entry.file, changed]]))).toThrow(failure);
});

it('LOCK-1: rejects a changed SQL predicate', () => {
  const { entry, source } = fixture('cornerWorkSql');
  const changed = source.replace('bool_or(NOT review)', 'bool_or(review)');
  expect(changed).not.toBe(source);
  expect(() => enforce([entry], new Map([[entry.file, changed]]))).toThrow(failure);
});

it('LOCK-1: permits comment-only edits and formatting', () => {
  const { entry, source } = fixture('deriveCornerState');
  const changed = source.replace('if (facts.turnRunning)', '/* owner-approved precedence */\n  if   ( facts.turnRunning )');
  expect(changed).not.toBe(source);
  enforce([entry], new Map([[entry.file, changed]]));
});

it.each(['removed', 'renamed'])('LOCK-1: rejects a %s declaration', change => {
  const { entry, source } = fixture('deriveCornerState');
  const changed = change === 'removed' ? '' : source.replace('function deriveCornerState(', 'function renamedState(');
  expect(() => enforce([entry], new Map([[entry.file, changed]]))).toThrow(failure);
});

it('LOCK-1: rejects a changed input type', () => {
  const { entry, source } = fixture('CornerStateFacts');
  const changed = source.replace('readonly turnRunning: boolean', 'readonly turnRunning: string');
  expect(changed).not.toBe(source);
  expect(() => enforce([entry], new Map([[entry.file, changed]]))).toThrow(failure);
});
