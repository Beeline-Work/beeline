import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import crypto from 'node:crypto';

export function scanErrorSurfaces(root) {
  const hits = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      if (!/\.tsx?$/.test(file) || /\.(test|spec)\./.test(file)) continue;
      const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      function visit(node) {
        if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
          const tag = node.tagName.getText(source);
          if (tag === 'ErrorBanner' || (tag === 'Text' && /(?:styles\.\w*[Ee]rror|\{\w*[Ee]rror\}|diagnostic\.(?:message|stack)|\{explanation\})/.test(node.parent.getText(source)))) {
            const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
            const ancestors = [];
            for (let parent = node.parent; parent; parent = parent.parent) {
              if (ts.isJsxElement(parent)) ancestors.push(parent.openingElement.getText(source));
            }
            const styleNames = new Set(ancestors.flatMap(text => Array.from(text.matchAll(/styles\.(\w+)/g), match => match[1])));
            const insets = [];
            function collectStyles(property) {
              if (ts.isPropertyAssignment(property) && styleNames.has(property.name.getText(source))) insets.push(property.getText(source));
              ts.forEachChild(property, collectStyles);
            }
            collectStyles(source);
            const layoutHash = crypto.createHash('sha256').update(insets.join('\n')).digest('hex');
            hits.push({ layoutHash, file: path.relative(root, file), line, tag, source: node.getText(source), ancestors });
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
  walk(root);
  return hits;
}

/** Isolate the production failure elements; replace only live data and callbacks. */
export function failureProofModule(root) {
  const files = ['app/(app)/beeline/channels.tsx', 'app/(app)/beeline/members.tsx', 'app/(app)/beeline/corners/[roomId].tsx', 'app/(app)/beeline/workflow.tsx', 'app/(app)/beeline/workflow-run.tsx', 'components/SidebarView.tsx', 'components/DesktopRoomInspector.tsx', 'components/buzz/WorkspaceSettingsPanel.tsx'];
  const printer = ts.createPrinter();
  const entries = files.map((file, index) => {
    const source = ts.createSourceFile(file, fs.readFileSync(path.join(root,file),'utf8'), ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
    const matches = [];
    function visit(node) {
      if (ts.isJsxSelfClosingElement(node) && ['IndexRow','SettingsRow'].includes(node.tagName.getText(source))) {
        if (index === 7 ? node.getText(source).includes('title="Allow fix sweep"') : node.getText(source).includes('action="Retry"')) matches.push(node);
      }
      ts.forEachChild(node,visit);
    }
    visit(source);
    const node=matches.at(-1);
    if (!node) throw new Error(`Missing production failure row in ${file}`);
    const attrs = node.attributes.properties.filter(prop => ts.isJsxAttribute(prop) && ['title','description','descriptionTone','action','onPress','inset','toggle'].includes(prop.name.text)).map(prop => {
      if (prop.name.text==='toggle') return 'toggle={{value:true,onValueChange:()=>undefined}}';
      if (prop.name.text==='onPress') return 'onPress={retry}';
      if (prop.name.text==='title' && index!==7) return 'title={appErrorCopy(error)}';
      if (prop.name.text==='description' && index===7) return 'description="Could not update Allow fix sweep."';
      if (prop.name.text==='descriptionTone') return 'descriptionTone="danger"';
      return printer.printNode(ts.EmitHint.Unspecified,prop,source);
    }).join(' ');
    return `(error, retry) => <${node.tagName.getText(source)} ${attrs} ${index===0?'testID="retry-proof"':''} />`;
  });
  return `import React from 'react'; import { IndexRow } from '@/components/buzz/IndexRow'; import { SettingsRow } from '@/components/buzz/SettingsRow'; import { appErrorCopy, connectionErrorDescription } from '@/buzz/app-error-copy'; export default [${entries.join(',\n')}];`;
}

/** Quoted JSX/JS strings do not interpolate error variables. */
export function scanErrorPlaceholders(root) {
  const hits = [];
  function walk(directory) {
    let entries;
    // Browser proof tests create and remove temporary folders under sources/test.
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'vendor') walk(file); continue; }
      if (!/\.tsx?$/.test(file) || /\.(test|spec)\./.test(file)) continue;
      const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      function visit(node) {
        if (ts.isStringLiteralLike(node)) {
          const value = node.text.replace(/&#(?:123|x7b);/gi, '{').replace(/&#(?:125|x7d);/gi, '}');
          if (/\{\s*(?:\w+\.)*(?:\w*(?:error|failure|exception|reason|caught|cause)\w*|err\w*)(?:\.\w+)*\s*\}/i.test(value)) {
            hits.push({ file: path.relative(root, file), line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, value: value.slice(0, 200) });
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
  walk(root);
  return hits;
}
