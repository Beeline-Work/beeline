// Conservative syntax inventory, not a claim that every candidate is removable.
import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const directory = fileURLToPath(new URL('.', import.meta.url));
const files = execFileSync('git', ['ls-files', 'apps/server'], { encoding: 'utf8' }).trim().split('\n');
const rows = [], manifest = [];
function descendants(node, predicate) {
  if (predicate(node)) return true;
  return !!ts.forEachChild(node, child => descendants(child, predicate));
}
function literal(node) {
  return ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) ||
    [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind);
}
function valueSpecific(node) {
  return descendants(node, n => ts.isBinaryExpression(n) &&
    [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(n.operatorToken.kind) &&
    (literal(n.left) || literal(n.right))) || descendants(node, n => ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) && ['has', 'includes'].includes(n.expression.name.text));
}
for (const file of files) {
  if (!/\.(?:[cm]?js|tsx?)$/.test(file) || /\/dist\//.test(file)) continue;
  const test = /(?:\.test\.|test-support|test-fixtures|\/fixtures\/)/.test(file);
  const source = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
    file.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  if (sf.parseDiagnostics.length) throw new Error(`Parse failed: ${file}`);
  const before = rows.length;
  function add(node, category, evidence, disposition = 'retain-until-semantic-review') {
    const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    rows.push({ file, line: pos.line + 1, column: pos.character + 1, category, disposition,
      evidence: evidence.replace(/\s+/g, ' ').slice(0, 1000) });
  }
  function handler(node, body) {
    if (!body) return;
    // A thrown replacement is error translation, not a swallowed exception.
    if (!descendants(body, ts.isThrowStatement)) add(node, 'non-propagating-handler', body.getText(sf));
  }
  function walk(n) {
    if (!test) {
      if (ts.isIfStatement(n) && valueSpecific(n.expression)) add(n, 'value-specific-branch', n.expression.getText(sf));
      if (ts.isConditionalExpression(n) && valueSpecific(n.condition)) add(n, 'value-specific-branch', n.condition.getText(sf));
      if (ts.isCaseClause(n)) add(n, 'value-specific-branch', n.expression.getText(sf));
      if (ts.isCatchClause(n)) handler(n, n.block);
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'catch') {
        const fn = n.arguments[0];
        if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) handler(n, fn.body);
        else add(n, 'non-propagating-handler', n.getText(sf));
      }
      // Boolean options are candidates, not automatically caller-specific.
      if (ts.isParameter(n) && (n.name.getText(sf).startsWith('_legacy') || n.type?.kind === ts.SyntaxKind.BooleanKeyword ||
          n.initializer && [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(n.initializer.kind))) {
        add(n, 'caller-parameter-candidate', n.getText(sf),
          n.name.getText(sf).startsWith('_legacy') ? 'avoidable-compatibility-slot' : 'retain-until-semantic-review');
      }
      if (ts.isVariableDeclaration(n) && n.initializer && ts.isNewExpression(n.initializer) &&
          n.initializer.expression.getText(sf) === 'Set' && descendants(n.initializer, ts.isStringLiteralLike)) {
        add(n, 'value-specific-set', n.getText(sf));
      }
      if (ts.isCallExpression(n) && /(?:^|\.)(?:sleep|delay|retry|setTimeout|setInterval)$/.test(n.expression.getText(sf))) {
        add(n, 'retry-sleep-or-scheduling-candidate', n.getText(sf));
      }
      if ((ts.isStringLiteralLike(n) || ts.isTemplateExpression(n)) && /\b(?:SELECT|UPDATE|INSERT|CREATE|ALTER|DELETE)\b/.test(n.getText(sf))) {
        const text = n.getText(sf);
        for (const match of text.matchAll(/\bCASE\s+(?:WHEN\b)?|\bON CONFLICT\b|\bIF (?:NOT )?EXISTS\b/gi)) {
          add(n, 'sql-conditional-policy', text.slice(Math.max(0, match.index - 40), match.index + 180));
        }
      }
    }
    if (test && ts.isCallExpression(n) && /\b(?:it|test|describe)\.(?:skip|todo|skipIf|runIf)\b/.test(n.expression.getText(sf))) {
      add(n, 'disabled-or-conditional-test', n.getText(sf));
    }
    ts.forEachChild(n, walk);
  }
  walk(sf); manifest.push({ file, test, sites: rows.length - before });
}
const counts = {}, dispositions = {};
for (const row of rows) {
  counts[row.category] = (counts[row.category] ?? 0) + 1;
  dispositions[row.disposition] = (dispositions[row.disposition] ?? 0) + 1;
}
const quote = value => '"' + String(value).replaceAll('"', '""') + '"';
writeFileSync(directory + 'candidate-sites.csv', ['file,line,column,category,disposition,evidence',
  ...rows.map(row => Object.values(row).map(quote).join(','))].join('\n') + '\n');
const summary = { sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  status: 'candidate inventory complete; semantic census incomplete',
  files: manifest.length, candidates: rows.length, counts, dispositions, manifest };
writeFileSync(directory + 'candidate-summary.json', JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ files: manifest.length, candidates: rows.length, counts, dispositions }));
