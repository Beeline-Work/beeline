// Build-time only: derive wire shapes from the authoritative operation maps.
// Unsupported TS shapes fail generation rather than silently becoming `unknown`.
import ts from 'typescript';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const sources = ['phone', 'daemon'].map(name => path.join(root, `packages/api-contract/src/${name}-operations.ts`));
const config = ts.readConfigFile(path.join(root, 'packages/api-contract/tsconfig.json'), ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.join(root, 'packages/api-contract'));
const program = ts.createProgram(sources, parsed.options);
const diagnostics = ts.getPreEmitDiagnostics(program).filter(item => item.category === ts.DiagnosticCategory.Error);
if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCurrentDirectory: () => root, getCanonicalFileName: name => name, getNewLine: () => '\n',
}));
const checker = program.getTypeChecker();
const nodes = [];
const visited = new Map();
const fail = (type, context) => { throw new Error(`Unsupported wire shape ${checker.typeToString(type)} at ${context}`); };
function shape(type, context) {
  if (visited.has(type)) return visited.get(type);
  const id = nodes.length;
  nodes.push(null); visited.set(type, id);
  const flags = ts.TypeFlags;
  const child = (value, suffix) => shape(value, `${context}.${suffix}`);
  let node;
  if (type.flags & (flags.Any | flags.Unknown)) node = { kind: 'json' };
  else if (type.flags & flags.Never) node = { kind: 'never' };
  else if (type.flags & flags.Void) node = { kind: 'literal', value: null };
  else if (type.flags & flags.Undefined) node = { kind: 'undefined' };
  else if (type.flags & flags.Null) node = { kind: 'literal', value: null };
  else if (type.flags & flags.StringLiteral) node = { kind: 'literal', value: type.value };
  else if (type.flags & flags.NumberLiteral) node = { kind: 'literal', value: type.value };
  else if (type.flags & flags.BooleanLiteral) node = { kind: 'literal', value: type.intrinsicName === 'true' };
  else if (type.flags & flags.TemplateLiteral) {
    if (!type.types.every(slot => slot.flags & (flags.String | flags.Number))) fail(type, context);
    if (type.types.length !== 1) fail(type, context);
    node = { kind: 'template', texts: type.texts, slots: type.types.map(slot => slot.flags & flags.Number ? 'number' : 'string') };
  }
  else if (type.flags & flags.String) node = { kind: 'string' };
  else if (type.flags & flags.Number) node = { kind: 'number' };
  else if (type.flags & flags.Boolean) node = { kind: 'boolean' };
  else if (type.isUnion()) node = { kind: 'union', choices: type.types.map((value, i) => child(value, i)) };
  else if (type.isIntersection()) node = { kind: 'intersection', choices: type.types.map((value, i) => child(value, i)) };
  else if (checker.isTupleType(type)) {
    const args = checker.getTypeArguments(type);
    if (type.target.elementFlags.some(flag => flag & (ts.ElementFlags.Rest | ts.ElementFlags.Variadic))) fail(type, context);
    node = { kind: 'tuple', items: args.map((value, i) => child(value, i)), min: type.target.minLength };
  } else if (checker.isArrayType(type) || type.symbol?.name === 'ReadonlyArray') {
    const args = checker.getTypeArguments(type);
    node = { kind: 'array', item: child(args[0], '[]') };
  } else if (type.flags & flags.Object) {
    if (checker.getSignaturesOfType(type, ts.SignatureKind.Call).length || checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length) fail(type, context);
    const properties = {};
    for (const property of checker.getPropertiesOfType(type)) {
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      if (!declaration) fail(type, `${context}.${property.name}`);
      properties[property.name] = { node: child(checker.getTypeOfSymbolAtLocation(property, declaration), property.name), optional: !!(property.flags & ts.SymbolFlags.Optional) };
    }
    const index = checker.getIndexTypeOfType(type, ts.IndexKind.String);
    const numericIndex = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
    if (numericIndex && !index) fail(type, context);
    node = { kind: 'object', properties, ...(index ? { index: child(index, '[key]') } : {}) };
  } else fail(type, context);
  nodes[id] = node;
  return id;
}
function resultShape(id) {
  const node = nodes[id];
  if (node.kind === 'undefined') { nodes.push({ kind: 'literal', value: null }); return nodes.length - 1; }
  if (node.kind === 'union') {
    const choices = node.choices.map(resultShape);
    if (choices.some((value, index) => value !== node.choices[index])) {
      nodes.push({ kind: 'union', choices }); return nodes.length - 1;
    }
  }
  return id;
}
const operations = {};
for (let i = 0; i < sources.length; i++) {
  const family = i === 0 ? 'phone' : 'daemon';
  const source = program.getSourceFile(sources[i]);
  const alias = source.statements.find(node => ts.isTypeAliasDeclaration(node) && node.name.text === `${i === 0 ? 'Phone' : 'Daemon'}OperationMap`);
  const type = checker.getTypeAtLocation(alias);
  for (const op of checker.getPropertiesOfType(type).sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const value = checker.getTypeOfSymbolAtLocation(op, op.valueDeclaration ?? op.declarations[0]);
    const contract = {};
    for (const side of ['input','output']) {
      const field = value.getProperty(side);
      if (!field) throw new Error(`${op.name} has no ${side}`);
      if (family === 'phone' && op.name === 'uploadMedia' && side === 'input') {
        contract[side] = 'file-bytes';
        continue;
      }
      contract[side] = shape(checker.getTypeOfSymbolAtLocation(field, field.valueDeclaration ?? field.declarations[0]), `${family}.${op.name}.${side}`);
    }
    contract.output = resultShape(contract.output);
    operations[`${family}.${op.name}`] = contract;
  }
}
const target = path.join(root, 'packages/net/src/generated-wire-shapes.ts');
const output = '// Generated by scripts/generate-network-codecs.mjs; edit the operation contracts, not this file.\n' +
  'import type { WireShape } from \'./wire-codec.js\';\n' +
  'const shape = (value: WireShape): WireShape => value;\n' +
  'export const wireShapes: readonly WireShape[] = [\n' + nodes.map(node => '  shape(' + JSON.stringify(node) + ')').join(',\n') + '\n];\n' +
  'export const operationShapes = ' + JSON.stringify(operations, null, 2) + ' as const;\n';
if (process.argv.includes('--check')) {
  if (readFileSync(target,'utf8') !== output) throw new Error('Network codecs are stale; run node scripts/generate-network-codecs.mjs');
} else writeFileSync(target, output);
console.log(`${Object.keys(operations).length} operation contracts; ${nodes.length} schema nodes`);

// A generated projection, not another declaration authority: the phone's M1
// observer needs inputs only, not daemon contracts or full response DTOs.
const inputNodes = [];
const inputIds = new Map();
function selectInput(id) {
  if (inputIds.has(id)) return inputIds.get(id);
  const next = inputNodes.length;
  inputIds.set(id, next); inputNodes.push(null);
  const node = nodes[id];
  let projected = node;
  if (node.kind === 'union' || node.kind === 'intersection') projected = { ...node, choices: node.choices.map(selectInput) };
  else if (node.kind === 'array') projected = { ...node, item: selectInput(node.item) };
  else if (node.kind === 'tuple') projected = { ...node, items: node.items.map(selectInput) };
  else if (node.kind === 'object') projected = { ...node,
    properties: Object.fromEntries(Object.entries(node.properties).map(([key, field]) => [key, { ...field, node: selectInput(field.node) }])),
    ...(node.index === undefined ? {} : { index: selectInput(node.index) }),
  };
  inputNodes[next] = projected;
  return next;
}
const inputOperations = Object.fromEntries(Object.entries(operations).filter(([id]) => id.startsWith('phone.'))
  .map(([id, contract]) => [id.slice('phone.'.length), contract.input === 'file-bytes' ? 'file-bytes' : selectInput(contract.input)]));
const inputOutput = '// Generated from the phone input projection by scripts/generate-network-codecs.mjs.\n' +
  'import type { WireShape } from \'./wire-codec.js\';\n' +
  'const shape = (value: WireShape): WireShape => value;\n' +
  'export const phoneInputShapes: readonly WireShape[] = [\n' + inputNodes.map(node => '  shape(' + JSON.stringify(node) + ')').join(',\n') + '\n];\n' +
  'export const phoneInputs = ' + JSON.stringify(inputOperations, null, 2) + ' as const;\n';
const inputTarget = path.join(root, 'packages/net/src/generated-phone-input-shapes.ts');
if (process.argv.includes('--check')) {
  if (readFileSync(inputTarget, 'utf8') !== inputOutput) throw new Error('Phone input codecs are stale; run node scripts/generate-network-codecs.mjs');
} else writeFileSync(inputTarget, inputOutput);
console.log(`${Object.keys(inputOperations).length} phone inputs; ${inputNodes.length} projected schema nodes`);
