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

// The trusted owner validates only its closed policy routes. Derive that subset
// from the policy declaration itself; do not ship the legacy observer's complete
// phone registry inside the independent admission owner.
const ownerSource = ts.createSourceFile('admission.ts', readFileSync(path.join(root,
  'packages/net/src/private/admission.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
let policyObject;
function findPolicies(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'policies') {
    const initializer = node.initializer;
    policyObject = initializer && ts.isAsExpression(initializer) ? initializer.expression : initializer;
  }
  ts.forEachChild(node, findPolicies);
}
findPolicies(ownerSource);
if (!policyObject || !ts.isObjectLiteralExpression(policyObject)) throw new Error('Owner policies must be a closed literal');
const ownerRoutes = policyObject.properties.map(property => {
  if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name)) throw new Error('Owner route must be literal');
  const route = property.name.text;
  if (!route.startsWith('phone.') || !operations[route] || operations[route].input === 'file-bytes')
    throw new Error(`Unsupported owner route ${route}`);
  return route;
});
inputNodes.length = 0; inputIds.clear();
const ownerOperations = Object.fromEntries(ownerRoutes.map(route => [route, selectInput(operations[route].input)]));
// Closed complete display families use generated value codecs in the
// trusted owner. Do not pull the complete legacy response registry into it.
const ownerResults={'phone.readScheduledWork':selectInput(operations['phone.readScheduledWork'].output),
  'phone.listRoomWorkflowRuns':selectInput(operations['phone.listRoomWorkflowRuns'].output),
  'phone.readWorkspace':selectInput(operations['phone.readWorkspace'].output),
  'phone.readTray':selectInput(operations['phone.readTray'].output)};
// Private owner encoding only. Keep the authoritative full and phone-input
// projections unchanged, and reconstruct their existing WireShape semantics.
function compactOwnerShape(node) {
  const primitive = ['json', 'never', 'undefined', 'string', 'number', 'boolean'].indexOf(node.kind);
  if (primitive !== -1) return primitive;
  switch (node.kind) {
    case 'literal': return [6, node.value];
    case 'template': return [7, node.texts, node.slots.map(slot => {
      if (slot === 'string') return 0;
      if (slot === 'number') return 1;
      throw new Error(`Unsupported owner template slot ${slot}`);
    })];
    case 'union': return [8, node.choices];
    case 'intersection': return [9, node.choices];
    case 'array': return [10, node.item];
    case 'tuple': return [11, node.items, node.min];
    case 'object': return [12, Object.fromEntries(Object.entries(node.properties).map(([key, field]) =>
      [key, field.optional ? -field.node - 1 : field.node])), ...(node.index === undefined ? [] : [node.index])];
    default: throw new Error(`Unsupported owner schema kind ${node.kind}`);
  }
}
const ownerOutput = '// Generated from trusted owner policies by scripts/generate-network-codecs.mjs.\n' +
  'import type { WireShape } from \'../wire-codec.js\';\n' +
  'import { expandWireShapes } from \'./compact-wire-shapes.js\';\n' +
  'export const ownerInputShapes: readonly WireShape[] = expandWireShapes([\n' + inputNodes.map(node =>
    // A generated field named __proto__ must remain an own schema key.
    '  ' + JSON.stringify(compactOwnerShape(node)).replaceAll('"__proto__":', '["__proto__"]:')).join(',\n') + '\n]);\n' +
  'export const ownerInputs = ' + JSON.stringify(ownerOperations, null, 2) + ' as const;\n'+
  'export const ownerResults = '+JSON.stringify(ownerResults,null,2)+' as const;\n';
const ownerTarget = path.join(root, 'packages/net/src/private/generated-owner-input-shapes.ts');
if (process.argv.includes('--check')) {
  if (readFileSync(ownerTarget, 'utf8') !== ownerOutput) throw new Error('Owner input codecs are stale; regenerate network codecs');
} else writeFileSync(ownerTarget, ownerOutput);
console.log(`${ownerRoutes.length} owner inputs; ${inputNodes.length} projected schema nodes`);

// Derive the helper consumer projection from its closed literal adapter calls.
// Preserve the complete input/result graphs; never copy a hand-written schema.
const helperRoutes = new Set();
for (const name of ['helper-codecs', 'helper-activation-codecs', 'helper-turn-codecs']) {
  const source = ts.createSourceFile(`${name}.ts`, readFileSync(path.join(root,
    `packages/net/src/${name}.ts`), 'utf8'), ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'helperRouteCodecs') {
      const id = node.arguments[0];
      if (node.arguments.length !== 1 || !ts.isStringLiteral(id) || !id.text.startsWith('daemon.') ||
          !operations[id.text] || operations[id.text].input === 'file-bytes') throw new Error('Helper route must be a closed daemon literal');
      helperRoutes.add(id.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
inputNodes.length = 0; inputIds.clear();
const helperOperations = Object.fromEntries([...helperRoutes].sort().map(id => [id, {
  input: selectInput(operations[id].input), output: selectInput(operations[id].output),
}]));
const helperOutput = '// Generated from helper consumer adapters by scripts/generate-network-codecs.mjs.\n' +
  'import type { WireShape } from \'./wire-codec.js\';\n' +
  'const shape = (value: WireShape): WireShape => value;\n' +
  'export const helperShapes: readonly WireShape[] = [\n' + inputNodes.map(node =>
    '  shape(' + JSON.stringify(node).replaceAll('"__proto__":', '["__proto__"]:') + ')').join(',\n') + '\n];\n' +
  'export const helperOperations = ' + JSON.stringify(helperOperations, null, 2) + ' as const;\n';
const helperTarget = path.join(root, 'packages/net/src/generated-helper-shapes.ts');
if (process.argv.includes('--check')) {
  if (readFileSync(helperTarget, 'utf8') !== helperOutput) throw new Error('Helper codecs are stale; regenerate network codecs');
} else writeFileSync(helperTarget, helperOutput);
console.log(`${helperRoutes.size} helper routes; ${inputNodes.length} projected schema nodes`);
