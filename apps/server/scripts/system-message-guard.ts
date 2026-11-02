import { createHash } from 'node:crypto';
import ts from 'typescript';

export type WordingCatalog = Record<
  string,
  { parts: readonly string[]; variables: readonly string[] }
>;
export const WORDING_APPROVAL_REQUIRED =
  'New or changed System-message wording. The owner (lunchboxfortwo) must approve wording before apps/server/system-message-wording.lock.json is updated.';
export const CATALOG_REQUIRED =
  'Inline System-message text. Add/use a key in packages/api-contract/src/system-message-catalog.ts; new wording requires owner approval.';

/** Read data from the source, so the guard never depends on a stale dist build. */
export function readWordingCatalog(source: string): WordingCatalog {
  const tree = ts.createSourceFile(
    'system-message-catalog.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  for (const statement of tree.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.name.getText(tree) !== 'SYSTEM_MESSAGE_CATALOG' || !declaration.initializer)
        continue;
      const expression = ts.isAsExpression(declaration.initializer)
        ? declaration.initializer.expression
        : declaration.initializer;
      if (!ts.isObjectLiteralExpression(expression))
        throw new Error('System-message catalog must contain literal template data');
      const catalog: WordingCatalog = {};
      const propertyName = (name: ts.PropertyName) =>
        ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;
      for (const property of expression.properties) {
        if (
          !ts.isPropertyAssignment(property) ||
          !ts.isObjectLiteralExpression(property.initializer)
        )
          throw new Error('Invalid System-message catalog entry');
        const key = propertyName(property.name);
        if (!key || Object.hasOwn(catalog, key))
          throw new Error(`Invalid or duplicate System-message key: ${key}`);
        const entry: Record<string, string[]> = {};
        for (const field of property.initializer.properties) {
          if (!ts.isPropertyAssignment(field) || !ts.isArrayLiteralExpression(field.initializer))
            throw new Error(`Invalid System-message template: ${key}`);
          const name = propertyName(field.name);
          if (name !== 'parts' && name !== 'variables')
            throw new Error(`Invalid System-message field: ${name}`);
          entry[name] = field.initializer.elements.map((value) => {
            if (!ts.isStringLiteralLike(value))
              throw new Error(`System-message ${key} must use literal text fragments`);
            return value.text;
          });
        }
        if (!entry.parts || !entry.variables)
          throw new Error(`Incomplete System-message template: ${key}`);
        catalog[key] = { parts: entry.parts, variables: entry.variables };
      }
      return catalog;
    }
  }
  throw new Error('System-message catalog data is missing');
}

/** Hash only exact rendered fragments. Variable descriptions and writer code are not wording. */
export function wordingHashes(catalog: WordingCatalog): Record<string, string> {
  return Object.fromEntries(
    Object.entries(catalog)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => {
        if (
          !Array.isArray(entry.parts) ||
          !entry.parts.every((part) => typeof part === 'string') ||
          !Array.isArray(entry.variables) ||
          !entry.variables.every((variable) => typeof variable === 'string') ||
          entry.parts.length !== entry.variables.length + 1
        )
          throw new Error(`Invalid System-message template: ${key}`);
        return [key, createHash('sha256').update(JSON.stringify(entry.parts)).digest('hex')];
      }),
  );
}

export function assertWordingLock(catalog: WordingCatalog, locked: Record<string, string>): void {
  const current = wordingHashes(catalog);
  const changed = [...new Set([...Object.keys(current), ...Object.keys(locked)])].filter(
    (key) => current[key] !== locked[key],
  );
  if (changed.length) throw new Error(`${WORDING_APPROVAL_REQUIRED}\n${changed.join('\n')}`);
}

export function assertCatalogUsage(nodes: readonly ts.Node[]): void {
  if (!nodes.length) return;
  throw new Error(
    `${CATALOG_REQUIRED}\n` +
      nodes
        .map((node) => {
          const source = node.getSourceFile();
          const { line } = source.getLineAndCharacterOfPosition(node.getStart());
          return `${source.fileName}:${line + 1}: ${node.getText().slice(0, 160)}`;
        })
        .join('\n'),
  );
}
