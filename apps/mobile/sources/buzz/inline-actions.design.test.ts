import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

// These surfaces contain main actions explicitly retained by the approved mock.
const mainActionFiles = new Set(['TranscriptCard.tsx', 'RunnableArtifact.tsx', 'ViewerConversationDock.tsx', 'ComputerSessionViewer.tsx']);
function violations(source: string, filename: string): string[] {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  function walk(node: ts.Node, contextual = /(?:Row|Card|Toast|Strip|MessageLine)\.tsx$/.test(filename)) {
    if (ts.isJsxElement(node)) {
      const tag = node.openingElement.tagName.getText(file);
      const props = node.openingElement.attributes.getText(file);
      contextual ||= /(?:Row|Card|Toast|Strip|MessageLine)$/.test(tag) || /style=\{[^}]*\.(?:\w*(?:[Rr]ow|[Cc]ard|[Tt]oast|[Ss]trip|[Ll]ine))\b/.test(props);
    }
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      if (node.tagName.getText(file) === 'Button' && contextual) {
        const value = (name: string) => {
          const attr = node.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(file) === name) as ts.JsxAttribute | undefined;
          return attr?.initializer && ts.isStringLiteral(attr.initializer) ? attr.initializer.text : undefined;
        };
        const variant = value('variant');
        if ((variant === 'primary' || variant === 'secondary') && value('size') !== 'inline' && !mainActionFiles.has(path.basename(filename)))
          found.push(`${filename}:${file.getLineAndCharacterOfPosition(node.pos).line + 1}`);
      }
    }
    ts.forEachChild(node, child => walk(child, contextual));
  }
  walk(file);
  return found;
}
it('rejects framed contextual actions, including nested row content', () => {
  expect(violations('<View style={styles.row}><View><Button variant="secondary" label="Retry" /></View></View>', 'Example.tsx')).toHaveLength(1);
  expect(violations('<Card><Button variant="primary" size="inline" label="Retry" /></Card>', 'Example.tsx')).toEqual([]);
});
it('keeps the entire mobile tree free of framed contextual actions', () => {
  function files(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(path.join(dir, entry.name)) : entry.name.endsWith('.tsx') && !entry.name.includes('.test.') ? [path.join(dir, entry.name)] : []);
  }
  expect(files('sources').flatMap(file => violations(fs.readFileSync(file, 'utf8'), file))).toEqual([]);
});
