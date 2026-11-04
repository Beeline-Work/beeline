/** Refresh reviewed failure-region evidence without changing historical before frames.
 * node apps/mobile/scripts/update-error-surface-evidence.mjs --write --reason '<reviewed inset rationale>'
 * Retarget changed JSX explicitly: --retarget sweep-04=IndexRow:transcriptHydrationError
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import { scanErrorSurfaces } from './error-surface-audit.mjs';
import { scanSharedControls } from './shared-control-audit.mjs';

const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = path.join(mobile, 'sources');
const args = process.argv.slice(2);
const write = args.includes('--write');
const reason = args[args.indexOf('--reason') + 1];
if (!args.includes('--reason') || typeof reason !== 'string' || reason.length < 30) throw new Error('Supply a reviewed inset rationale with --reason (at least 30 characters).');
const targets = new Map();
for (let index = 0; index < args.length; index++) {
  if (args[index] !== '--retarget') continue;
  const value = args[++index];
  if (!value) throw new Error('Expected a value after --retarget');
  const equals = value.indexOf('=');
  const colon = value.indexOf(':', equals);
  if (equals < 0 || colon < 0) throw new Error('Expected --retarget case-id=Tag:unique-source-fragment');
  targets.set(value.slice(0, equals), { tag: value.slice(equals + 1, colon), fragment: value.slice(colon + 1) });
}
const hash = text => crypto.createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex');
const tag = node => (ts.isJsxElement(node) ? node.openingElement : node).tagName.getText();
const manifestPath = path.join(mobile, 'scripts/error-sweep-proof-cases.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
for (const entry of manifest.cases) {
  const source = ts.createSourceFile(entry.file, fs.readFileSync(path.join(sources, entry.file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const elements = [];
  function visit(node) {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) elements.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  const target = targets.get(entry.id);
  if (target) {
    const matches = elements.filter(node => tag(node) === target.tag && node.getText(source).includes(target.fragment));
    if (matches.length !== 1) throw new Error(`${entry.id}: retarget must identify exactly one production element; found ${matches.length}`);
    const node = matches[0];
    const fingerprint = hash(node.getText(source));
    entry.after.selectors = [{ tag: target.tag, hash: fingerprint, occurrence: elements.filter(candidate => tag(candidate) === target.tag && hash(candidate.getText(source)) === fingerprint).indexOf(node) }];
  }
  const selected = entry.after.selectors.map(selector => elements.filter(node => tag(node) === selector.tag && hash(node.getText(source)) === selector.hash)[selector.occurrence]);
  if (selected.some(node => !node)) throw new Error(`${entry.id}: changed JSX requires an explicit --retarget`);
  entry.after.sourceLine = source.getLineAndCharacterOfPosition(selected[0].getStart(source)).line + 1;
}
function refreshed(file, hits, key) {
  const previous = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entries = hits.map(hit => ({ ...hit, reason: previous.find(old => key(old) === key(hit))?.reason ?? reason }));
  if (write) fs.writeFileSync(file, JSON.stringify(entries, null, 2) + '\n');
  console.log(`${path.basename(file)}: ${previous.length} → ${entries.length}`);
}
refreshed(path.join(mobile, 'design/error-surface-allowlist.json'), scanErrorSurfaces(sources), hit => `${hit.file}:${hit.tag}:${hit.source}`);
refreshed(path.join(mobile, 'design/shared-control-allowlist.json'), scanSharedControls(sources), hit => hit.id);
if (write) fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`${write ? 'Updated' : 'Validated'} ${manifest.cases.length} current selectors; historical before frames unchanged.`);
