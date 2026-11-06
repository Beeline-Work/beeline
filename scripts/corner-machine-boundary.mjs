import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { sourceFiles } from './router-boundaries.mjs';

const OWNER = 'apps/server/src/corner-lifecycle.ts';
/** No inventories or exemption lists: corner decisions and dispatch have one owner. */
export function inspectCornerMachineSource(file, text) {
  if (file === OWNER) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const errors = [];
  const deny = (node, reason) =>
    errors.push(
      `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: corner machine boundary: ${reason}; emit advanceCorner instead`,
    );
  const queueNames = new Set(['createAgentCommand']);
  function visit(node) {
    if ((ts.isExportDeclaration(node) || ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamespaceImport(node.importClause.namedBindings)) &&
        node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && /\/agent-command(?:\.[jt]s)?$/.test(node.moduleSpecifier.text))
      deny(node, 'raw command capability escapes through a namespace or re-export');
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      /\/agent-command(?:\.[jt]s)?$/.test(node.moduleSpecifier.text)
    ) {
      for (const binding of node.importClause?.namedBindings?.elements ?? []) {
        const imported = binding.propertyName?.text ?? binding.name.text;
        if (imported === 'insertAgentCommand')
          deny(binding, 'raw command queue capability escapes the machine');
        if (imported === 'createAgentCommand') queueNames.add(binding.name.text);
      }
    }
    if (
      (ts.isStringLiteralLike(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      /\b(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+(?:[\w"]+\s*\.\s*)?"?corner_facts"?\b/i.test(
        node.text,
      )
    )
      deny(node, 'corner state write outside its owner');
    if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) &&
        /\bUPDATE\s+(?:[\w"]+\s*\.\s*)?"?rooms"?\s+(?:(?:AS\s+)?\w+\s+)?SET\b[^;]*\barchived_at\s*=/is.test(node.text))
      deny(node, 'corner archival write outside its owner');
    if (ts.isCallExpression(node) && queueNames.has(node.expression.getText(source))) {
      const input = node.arguments[1];
      if (
        input &&
        ts.isObjectLiteralExpression(input) &&
        input.properties.some(
          (p) =>
            ts.isPropertyAssignment(p) &&
            (ts.isStringLiteralLike(p.name) ? p.name.text : p.name.getText(source)) === 'reason' &&
            ts.isStringLiteralLike(p.initializer) &&
            p.initializer.text.startsWith('corner_'),
        )
      )
        deny(node, 'corner command creation outside its owner');
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return errors;
}
export function checkCornerMachine(root) {
  return sourceFiles(root)
    .filter((file) => file.startsWith('apps/server/src/'))
    .flatMap((file) =>
      inspectCornerMachineSource(file, readFileSync(path.join(root, file), 'utf8')),
    );
}
