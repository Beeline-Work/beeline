import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from 'typescript';

/** AST inventory: every exception is keyed to the exact control, never a whole feature directory. */
export function scanSharedControls(root) {
  const hits = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) { walk(absolute); continue; }
      if (!/\.tsx$/.test(absolute) || /\.(test|spec)\.tsx$/.test(absolute)) continue;
      const source = fs.readFileSync(absolute, 'utf8');
      const file = path.relative(root, absolute).split(path.sep).join('/');
      const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const borderedStyles = new Set();
      const collectStyles = node => {
        if (ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.initializer)
          && /\bborder(?:Width|TopWidth|BottomWidth|Color)\s*:/.test(node.initializer.getText(sf))) {
          borderedStyles.add(node.name.getText(sf));
        }
        ts.forEachChild(node, collectStyles);
      };
      collectStyles(sf);
      const add = (node, rule, detail) => {
        const text = node.getText(sf);
        hits.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, rule, detail,
          id: crypto.createHash('sha256').update(file + '\0' + rule + '\0' + text.replace(/\s+/g, ' ')).digest('hex').slice(0, 20),
          control: text.replace(/\s+/g, ' ').slice(0, 400) });
      };
      const visit = (node) => {
        if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
          const opening = ts.isJsxElement(node) ? node.openingElement : node;
          const tag = opening.tagName.getText(sf);
          const text = node.getText(sf);
          if (/(?:^|\.)(?:\w*Pressable|\w*TouchableOpacity|TouchableHighlight)$/.test(tag) && /<(?:Text|\w*Text|Animated\.Text)\b/.test(text)) {
            add(node, '6a', 'raw text target');
          }
          if (tag === 'HullDialogActions') add(node, '6c', 'dialog action row');
          const style = opening.attributes.properties.find(property => ts.isJsxAttribute(property) && property.name.getText(sf) === 'style');
          if (tag === 'View' && style && (/(error|failure|retry|repoPrompt)/i.test(style.getText(sf)) || [...borderedStyles].some(name => style.getText(sf).includes(`styles.${name}`))) && /<(?:Button|HullDialogActions)\b/.test(text) && /(?:Retry|Try again|Reconnect|Connect)/.test(text)) {
            add(node, '6b', 'custom failure/reconnect notice with an action');
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);

    }
  };
  walk(root);
  return hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
}
