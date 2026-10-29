import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from 'typescript';

const normalize = text => text.replace(/\s+/g, ' ').trim();
const hash = text => crypto.createHash('sha256').update(normalize(text)).digest('hex');
const opening = node => ts.isJsxElement(node) ? node.openingElement : node;

function elements(source) {
  const found = [];
  function visit(node) {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) found.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

function surroundingStyles(source, nodes) {
  const wrappers = [];
  for (let parent = nodes[0].parent; parent; parent = parent.parent) {
    if (!ts.isJsxElement(parent) || !['View', 'ScrollView'].includes(parent.openingElement.tagName.getText(source))) continue;
    for (const attribute of parent.openingElement.attributes.properties) {
      if (ts.isJsxAttribute(attribute) && ['style', 'contentContainerStyle'].includes(attribute.name.text)) {
        wrappers.push(attribute.initializer.expression.getText(source));
      }
    }
  }
  let factory;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ['styles', 'stylesheet'].includes(node.name.getText(source)) && ts.isCallExpression(node.initializer)) {
      factory = node.initializer.arguments[0];
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  let object = factory?.body;
  if (object && ts.isBlock(object)) object = object.statements.find(ts.isReturnStatement)?.expression;
  while (object && ts.isParenthesizedExpression(object)) object = object.expression;
  const properties = new Map((object?.properties ?? []).map(property => [property.name?.getText(source), property.getText(source)]));
  const used = nodes.map(node => node.getText(source)).join('\n') + wrappers.join('\n');
  const names = new Set(Array.from(used.matchAll(/styles\.(\w+)/g), match => match[1]));
  return { jsx: nodes.map(node => node.getText(source)), wrappers, styles: Array.from(names, name => {
    if (!properties.has(name)) throw new Error(`Missing production style ${source.fileName}:${name}`);
    return properties.get(name);
  }) };
}

/** Keep the source JSX and source insets; substitute only the failing data and callbacks. */
function fixtureJsx(snapshot, entry) {
  const jsx = ts.createSourceFile('fixture.tsx', `const fixture = <>${snapshot.jsx.join('\n')}</>;`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const printer = ts.createPrinter();
  const transform = context => root => {
    function visit(node) {
      if (ts.isJsxAttribute(node)) {
        const name = node.name.text;
        if (/^on[A-Z]/.test(name)) return ts.factory.updateJsxAttribute(node, node.name, ts.factory.createJsxExpression(undefined, ts.factory.createIdentifier('retry')));
        if (['accessibilityLabel', 'descriptionContent', 'descriptionAction', 'leading', 'trailing'].includes(name)) return undefined;
        if (node.initializer && ts.isJsxExpression(node.initializer)) {
          const text = node.initializer.expression?.getText(jsx) ?? '';
          let expression;
          if (name === 'title') {
            expression = text === 'notice.title' ? 'noticeTitle' : /error|Error|attention|notice|explanation/.test(text) ? 'snapshotError' : 'rowTitle';
          } else if (name === 'description') {
            expression = text.includes('connectionErrorDescription') ? 'snapshotError === connectionErrorTitle ? connectionErrorDescription : undefined' : /error|Error|notice|explanation/.test(text) ? 'snapshotError' : 'undefined';
          } else if (name === 'descriptionTone') expression = '"danger"';
          else if (name === 'toggle') expression = '({value:true,onValueChange:retry})';
          else if (name === 'value') expression = text.includes('workspace?.name') ? '"Beeline"' : '"Private"';
          else if (name === 'action') expression = '"Copy"';
          else if (name === 'disabled' || name === 'retrying') expression = 'false';
          // A live fallback action needs page state the isolated fixture does not hold.
          else if (name === 'secondaryAction' || name === 'retryLabel') expression = 'undefined';
          else if (name === 'testID') expression = JSON.stringify(entry.id);
          if (expression) {
            // Emit this expression as a synthetic node so its source positions cannot bind to the JSX file.
            return ts.factory.updateJsxAttribute(node, node.name, ts.factory.createJsxExpression(undefined, ts.factory.createIdentifier(expression)));
          }
        }
      }
      if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
        const text = node.expression.getText(jsx);
        if (!/<\w/.test(text) && /error|Error|attention|explanation|notice\.message/.test(text)) {
          return ts.factory.createJsxExpression(undefined, ts.factory.createIdentifier('snapshotError'));
        }
      }
      return ts.visitEachChild(node, visit, context);
    }
    return ts.visitNode(root, visit);
  };
  const result = ts.transform(jsx, [transform]);
  let output = printer.printFile(result.transformed[0]).replace(/^const fixture = /, '').replace(/;\s*$/, '');
  result.dispose();
  // The fixture retains the original ancestor nesting and the style expressions that supply its inset.
  for (const style of snapshot.wrappers) output = `<View style={${style}}>${output}</View>`;
  return output;
}

export function changedSweepProofModule(mobile) {
  const manifest = JSON.parse(fs.readFileSync(path.join(mobile, 'scripts/error-sweep-proof-cases.json'), 'utf8'));
  const cases = manifest.cases.map(entry => {
    const file = path.join(mobile, 'sources', entry.file);
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const candidates = elements(source);
    const nodes = entry.after.selectors.map(selector => {
      const node = candidates.filter(node => opening(node).tagName.getText(source) === selector.tag && hash(node.getText(source)) === selector.hash)[selector.occurrence];
      if (!node) throw new Error(`Production failure JSX changed: ${entry.label}; regenerate its evidence selector.`);
      return node;
    });
    const after = surroundingStyles(source, nodes);
    const runtime = entry.file.includes('RuntimeErrorBoundary');
    const body = (snapshot, side) => `function ${side}() {
      const themeRoot = useUnistyles().theme;
      const theme = ${runtime ? 'themeRoot.buzz' : 'themeRoot'};
      const hull = themeRoot.buzz;
      const styles = StyleSheet.create(theme => {
        const hull = theme.buzz, groknight = hull, board = appBoardColors(hull);
        return {${snapshot.styles.join(',\n')}};
      });
      const stylesheet = styles;
      const snapshotError = ${side === 'Before' ? entry.fallback ? JSON.stringify(entry.fallback.replace(/\.$/, '') + ': Error: unknown') : 'String(error)' : `appErrorCopy(${entry.fallback ? "new Error('unknown')" : 'error'}${entry.fallback || entry.screenFallback ? ', ' + JSON.stringify(entry.fallback ?? entry.screenFallback) : ''})`};
      const rowTitle = ${JSON.stringify(entry.rowTitle ?? 'general')};
      return ${fixtureJsx(snapshot, entry)};
    }`;
    return `{id:${JSON.stringify(entry.id)}, label:${JSON.stringify(entry.label)}, afterLine:${entry.after.sourceLine}, Before:(()=>{${body(entry.before, 'Before')} return Before;})(), After:(()=>{${body(after, 'After')} return After;})()}`;
  });
  return `import React from 'react';
    import { View, Text, ScrollView, Platform } from 'react-native';
    import { StyleSheet, useUnistyles } from 'react-native-unistyles';
    import { Typography } from '@/constants/Typography';
    import { desktopColumnWidths } from '@/buzz/desktop-layout-tokens';
    import { appBoardColors } from '@/buzz/app-board-style';
    import { layout } from '@/buzz/groknight';
    import { Button } from '@/components/buzz/Button';
    import { SettingsRow } from '@/components/buzz/SettingsRow';
    import { IndexRow } from '@/components/buzz/IndexRow';
    import { ErrorBanner } from '@/components/buzz/ErrorBanner';
    import { appErrorCopy, connectionErrorTitle, connectionErrorDescription } from '@/buzz/app-error-copy';
    import { RoomViewHttpError } from '@beeline/buzz-client';
    const error = new RoomViewHttpError(504,'surface_request_timed_out');
    const retry = () => undefined;
    const insets = {top:0,bottom:0,left:0,right:0}, safeArea = insets;
    const renderedWidth = (window.innerWidth-48)/2, macTitlebarInset = 0, headerHeight = 0;
    const desktopPageLayout = window.innerWidth >= 1000, isDesktop = desktopPageLayout, desktop = desktopPageLayout;
    const scope = 'app', noticeTitle = 'HANDLE NOT CLAIMED', renamingWorkspace = false;
    const diagnostic = {message:String(error),stack:'RoomViewHttpError: Room view request failed (504 surface_request_timed_out)\\n at RoomList (app.bundle:1:42)'};
    export default [${cases.join(',\n')}];`;
}

export function writeEvidenceBoard(output) {
  const encode = file => fs.readFileSync(path.join(output, file)).toString('base64');
  const images = fs.readdirSync(output).filter(file => file.endsWith('.png')).sort();
  const headings = images.map(file => {
    const changed = file.startsWith('changed-');
    const label = file.replace('.png', '').replaceAll('-', ' · ');
    return `<details id="${file.slice(0,-4)}" ${changed ? '' : 'open'}><summary>${label}</summary><img alt="${label}" src="data:image/png;base64,${encode(file)}"></details>`;
  });
  const manifest = JSON.parse(fs.readFileSync(new URL('./error-sweep-proof-cases.json', import.meta.url), 'utf8'));
  const rows = manifest.cases.map((entry, index) => `<tr><td>${entry.label.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</td><td>${Math.floor(index / 6) + 1}</td><td>${['bone','obsidian'].flatMap(theme => [828,1440].map(width => `<a href="#changed-${theme}-${width}-page-${Math.floor(index/6)+1}">${theme} ${width===828?'phone':'web'}</a>`)).join(' · ')} · before / after</td></tr>`).join('');
  fs.writeFileSync(path.join(output, '..', 'error-proof.html'), `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Failure rows: complete browser evidence</title><style>body{margin:0;padding:24px;background:#14091a;color:#f0f0f3;font:16px sans-serif}h1{font-size:22px}p{color:#c9c9d1;max-width:76ch}img{width:100%;height:auto;border:1px solid #291e33}details{margin:24px 0}summary,a{color:#b08a4a}summary{cursor:pointer}table{border-collapse:collapse;font-size:13px;width:100%}td,th{border-bottom:1px solid #291e33;padding:8px;text-align:left;overflow-wrap:anywhere}</style><h1>Failure rows: complete browser evidence</h1><p>The original mock places and every changed inventory row are shown before and after in Bone and Obsidian at phone and web widths. Changed-sweep fixtures retain the source failure elements and surrounding source styles. Before JSX is pinned to the pre-fix commit; after JSX is extracted from current production source. Live data and callbacks are substituted. These are isolated browser fixtures, not authenticated full-page captures.</p><p>R2: Workflow settings now renders the real error sentence and Retry. Its before snapshot preserves the literal placeholder from commit 4a6e33172; the dedicated Workflow placeholder sheets and changed-sweep page 5 show the corrected production row.</p><table><tr><th>Changed inventory location</th><th>Sweep page</th><th>Coverage</th></tr>${rows}</table>${headings.join('')}</html>`);
}
