import { readFileSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const sourceDir = dirname(fileURLToPath(import.meta.url));

it('requires review for every new System DM destination producer', () => {
  const sites: string[] = [];
  for (const file of readdirSync(sourceDir).filter(file => file.endsWith('.ts') && !file.includes('.test.'))) {
    const source = ts.createSourceFile(file, readFileSync(`${sourceDir}/${file}`, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
          ['ensureSystemDirectMessageRoom', 'ensureSystemDirectMessageRoomResult', 'sendFixedMessage', 'workspaceSystemLine', 'directMessageRoomId'].includes(node.expression.text)) {
        let scope = node.parent;
        while (scope && !ts.isFunctionDeclaration(scope) && !ts.isMethodDeclaration(scope)) scope = scope.parent;
        const name = scope && 'name' in scope && scope.name ? scope.name.getText(source) : '<module>';
        sites.push(`${file}:${name}:${node.expression.text}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(sites.sort()).toMatchSnapshot();
});
