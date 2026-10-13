import ts from 'typescript';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const printer = ts.createPrinter({ removeComments: true });
const primitives = new Set([
  'TextInput',
  'Pressable',
  'TouchableOpacity',
  'TouchableHighlight',
  'TouchableNativeFeedback',
  'TouchableWithoutFeedback',
  'View',
  'Text',
]);
const touches = new Set([...primitives].filter((name) => /Pressable|Touchable/.test(name)));
export const REGISTRY_PATH = 'apps/mobile/design/ui-component-registry.json';
const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 20);
const normalize = (node, sourceFile) =>
  printer.printNode(ts.EmitHint.Unspecified, node, sourceFile);

export function uiSourceFiles(root) {
  const files = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!['test', 'vendor', 'node_modules'].includes(entry.name)) walk(file);
      } else if (
        /\.[jt]sx?$/.test(entry.name) &&
        !/\.(test|spec|gen)\.[jt]sx?$|\.d\.ts$/.test(entry.name)
      ) {
        files.push({
          file: path
            .relative(path.join(root, 'apps/mobile/sources'), file)
            .split(path.sep)
            .join('/'),
          source: readFileSync(file, 'utf8'),
        });
      }
    }
  }
  walk(path.join(root, 'apps/mobile/sources'));
  return files.sort((a, b) => a.file.localeCompare(b.file));
}

export function uiContext(source, file) {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    /\.(tsx|jsx|js)$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  if (sourceFile.parseDiagnostics.length)
    throw new Error(
      `${file}: ${ts.flattenDiagnosticMessageText(sourceFile.parseDiagnostics[0].messageText, '\n')}`,
    );
  const bindings = new Map();
  const namespaces = new Set();
  const declarations = new Map();
  const styleProperties = new Map();
  function index(node) {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === 'react-native'
    ) {
      const clause = node.importClause?.namedBindings;
      if (clause && ts.isNamespaceImport(clause)) namespaces.add(clause.name.text);
      if (clause && ts.isNamedImports(clause))
        for (const binding of clause.elements) {
          const imported = binding.propertyName?.text ?? binding.name.text;
          if (primitives.has(imported) && !binding.isTypeOnly)
            bindings.set(binding.name.text, imported);
        }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      declarations.set(node.name.text, node.initializer);
    if (ts.isPropertyAssignment(node))
      styleProperties.set(
        node.name.getText(sourceFile).replace(/^['"]|['"]$/g, ''),
        node.initializer,
      );
    ts.forEachChild(node, index);
  }
  index(sourceFile);
  function primitive(expression, seen = new Set()) {
    const name = expression.getText(sourceFile);
    if (bindings.has(name)) return bindings.get(name);
    if (
      ts.isPropertyAccessExpression(expression) &&
      namespaces.has(expression.expression.getText(sourceFile)) &&
      primitives.has(expression.name.text)
    )
      return expression.name.text;
    if (declarations.has(name) && !seen.has(name)) {
      seen.add(name);
      return primitive(declarations.get(name), seen);
    }
    return null;
  }
  function resolveStyle(expression, seen = new Set()) {
    if (!expression || seen.has(expression)) return '';
    seen.add(expression);
    const text = normalize(expression, sourceFile);
    if (ts.isIdentifier(expression) && declarations.has(text))
      return text + ' ' + resolveStyle(declarations.get(text), seen);
    if (ts.isPropertyAccessExpression(expression) && styleProperties.has(expression.name.text))
      return text + ' ' + resolveStyle(styleProperties.get(expression.name.text), seen);
    let result = text;
    ts.forEachChild(expression, (child) => {
      result += ' ' + resolveStyle(child, seen);
    });
    return result;
  }
  function owner(node) {
    for (let current = node.parent; current; current = current.parent) {
      if (
        (ts.isFunctionDeclaration(current) ||
          ts.isClassDeclaration(current) ||
          ts.isVariableDeclaration(current)) &&
        current.name
      )
        return current.name.getText(sourceFile);
    }
    return '<module>';
  }
  return { sourceFile, source, file, primitive, resolveStyle, owner };
}

function controlContext(node, context) {
  let tag,
    properties,
    body,
    spread = false;
  if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
    tag = node.tagName;
    spread = node.attributes.properties.some(ts.isJsxSpreadAttribute);
    properties = new Map(
      node.attributes.properties
        .filter(ts.isJsxAttribute)
        .map((prop) => [prop.name.getText(context.sourceFile), prop.initializer]),
    );
    body = ts.isJsxOpeningElement(node) ? node.parent : node;
  } else if (
    ts.isCallExpression(node) &&
    /^(React\.)?createElement$/.test(node.expression.getText(context.sourceFile)) &&
    node.arguments[0]
  ) {
    tag = node.arguments[0];
    const props = node.arguments[1];
    spread = Boolean(
      (props && !ts.isObjectLiteralExpression(props)) ||
      (props &&
        ts.isObjectLiteralExpression(props) &&
        props.properties.some(ts.isSpreadAssignment)),
    );
    properties = new Map(
      props && ts.isObjectLiteralExpression(props)
        ? props.properties
            .filter(ts.isPropertyAssignment)
            .map((prop) => [
              prop.name.getText(context.sourceFile).replace(/^['"]|['"]$/g, ''),
              prop.initializer,
            ])
        : [],
    );
    body = node;
  } else return null;
  const primitive = context.primitive(tag);
  if (!primitive) return null;
  const styleNode = properties.get('style');
  const style = context.resolveStyle(styleNode);
  return {
    ...context,
    node,
    primitive,
    properties,
    spread,
    style,
    body,
    text: body.getText(context.sourceFile),
  };
}

// Alignment-specific rules join this list. A rule returns one diagnostic message
// or null; the common scanner, grandfather registry and required CI gate own enforcement.
export const UI_CONTROL_RULES = [
  {
    id: 'raw-text-input',
    check: (c) =>
      c.primitive === 'TextInput'
        ? 'Use a registered shared text field instead of raw TextInput.'
        : null,
  },
  {
    id: 'raw-button',
    check: (c) =>
      touches.has(c.primitive) &&
      (/["']button["']/.test(c.properties.get('accessibilityRole')?.getText(c.sourceFile) ?? '') ||
        c.properties.has('style') ||
        c.properties.has('onPress') ||
        c.spread)
        ? 'Use Button instead of styling a native touch target as a button.'
        : null,
  },
  {
    id: 'custom-row',
    check: (c) =>
      (c.primitive === 'View' || touches.has(c.primitive)) &&
      c.properties.has('style') &&
      (/\b(?:row|Row)\b|[a-z]Row\b|flexDirection\s*:\s*['"]row['"]/.test(c.style) ||
        /Row$/.test(c.owner(c.node)))
        ? 'Use a registered shared row instead of a custom row.'
        : null,
  },
  {
    id: 'custom-header',
    check: (c) =>
      ['View', 'Text'].includes(c.primitive) &&
      (/["']heading["']/.test(c.properties.get('accessibilityRole')?.getText(c.sourceFile) ?? '') ||
        (c.properties.has('style') &&
          (/header|Header/.test(c.style) || /Header$/.test(c.owner(c.node)))))
        ? 'Use PageHeader or a registered shared header.'
        : null,
  },
  {
    id: 'custom-dialog-footer',
    check: (c) =>
      c.primitive === 'View' &&
      c.properties.has('style') &&
      /footer|Footer|actions|Actions/.test(c.style) &&
      /Dialog|Modal|Sheet|dialog|modal|sheet/.test(c.file + ' ' + c.owner(c.node) + ' ' + c.text)
        ? 'Use registered shared dialog actions instead of a custom dialog footer.'
        : null,
  },
];

function containsUi(node) {
  let found = false;
  function visit(child) {
    if (
      ts.isJsxElement(child) ||
      ts.isJsxSelfClosingElement(child) ||
      ts.isJsxFragment(child) ||
      (ts.isCallExpression(child) &&
        /^(React\.)?(createElement|memo|forwardRef)$/.test(child.expression.getText()))
    )
      found = true;
    if (!found) ts.forEachChild(child, visit);
  }
  visit(node);
  return found;
}

export function scanUiSource(source, file, rules = UI_CONTROL_RULES) {
  const context = uiContext(source, file);
  const components = new Set();
  const offences = [];
  function component(name, body) {
    if (
      name &&
      (name === 'default' || /^[A-Z][\w$]*$/.test(name)) &&
      body &&
      (ts.isFunctionDeclaration(body) ||
        ts.isClassDeclaration(body) ||
        ts.isArrowFunction(body) ||
        ts.isFunctionExpression(body) ||
        ts.isCallExpression(body) ||
        ts.isIdentifier(body) ||
        ts.isPropertyAccessExpression(body) ||
        ts.isElementAccessExpression(body) ||
        ts.isConditionalExpression(body) ||
        containsUi(body) ||
        context.primitive(body) ||
        /(?:ReactElement|ReactNode|JSX\.Element)/.test(body.getText(context.sourceFile)))
    )
      components.add(name);
  }
  function visit(node) {
    if (file.startsWith('components/')) {
      if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node))
        component(
          node.name?.text ??
            (node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
              ? 'default'
              : null),
          node,
        );
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name))
        component(node.name.text, node.initializer);
      if (
        ts.isExportAssignment(node) ||
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
      )
        components.add('default');
      if (ts.isExportDeclaration(node) && !node.isTypeOnly && !node.exportClause)
        components.add('export:*:' + node.moduleSpecifier?.getText(context.sourceFile));
      if (
        ts.isExportDeclaration(node) &&
        node.exportClause &&
        ts.isNamespaceExport(node.exportClause)
      )
        components.add(node.exportClause.name.text);
      if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause))
        for (const element of node.exportClause.elements) {
          if (
            !node.isTypeOnly &&
            !element.isTypeOnly &&
            (element.name.text === 'default' || /^[A-Z][\w$]*$/.test(element.name.text))
          )
            components.add(element.name.text);
        }
    } else {
      const control = controlContext(node, context);
      if (control)
        for (const rule of rules) {
          const message = rule.check(control);
          if (message) {
            const line =
              context.sourceFile.getLineAndCharacterOfPosition(node.getStart(context.sourceFile))
                .line + 1;
            // Exact AST + owning function pins legacy controls; comments and formatting
            // are harmless, while changing a legacy control asks for shared-component migration.
            const fingerprint = hash(
              `${rule.id}\n${context.owner(node)}\n${normalize(control.body, context.sourceFile)}\n${control.style.replace(/\s+/g, ' ').trim()}`,
            );
            offences.push({ rule: rule.id, file, line, fingerprint, message });
          }
        }
    }
    ts.forEachChild(node, visit);
  }
  visit(context.sourceFile);
  return { file, components: [...components].sort(), offences };
}

export function scanUiTree(root) {
  return uiSourceFiles(root).map(({ file, source }) => scanUiSource(source, file));
}

export function grandfatherRegistry(scans) {
  return {
    version: 1,
    components: Object.fromEntries(
      scans
        .filter((scan) => scan.file.startsWith('components/'))
        .map((scan) => [scan.file, scan.components]),
    ),
    legacyControls: Object.fromEntries(
      scans
        .filter((scan) => scan.offences.length)
        .map((scan) => [
          scan.file,
          Object.fromEntries(
            [...new Set(scan.offences.map((o) => o.fingerprint))]
              .sort()
              .map((fingerprint) => [
                fingerprint,
                scan.offences.filter((o) => o.fingerprint === fingerprint).length,
              ]),
          ),
        ]),
    ),
  };
}

export function judgeUiRegistry(scans, registry, baseRegistry) {
  if (registry.version !== 1 || !registry.components || !registry.legacyControls)
    throw new Error(
      'Invalid UI component registry (expected version 1, components and legacyControls).',
    );
  const errors = [];
  if (baseRegistry)
    for (const [file, entries] of Object.entries(registry.legacyControls)) {
      for (const [fingerprint, count] of Object.entries(entries)) {
        if (
          !Number.isSafeInteger(count) ||
          count < 1 ||
          count > (baseRegistry.legacyControls[file]?.[fingerprint] ?? 0)
        )
          errors.push({
            file,
            line: 1,
            rule: 'grandfather-growth',
            message:
              'Legacy control exceptions may only shrink. Move new controls into registered shared components.',
          });
      }
    }
  for (const scan of scans) {
    if (scan.file.startsWith('components/')) {
      if (!Object.hasOwn(registry.components, scan.file))
        errors.push({
          file: scan.file,
          line: 1,
          rule: 'component-file',
          message: `New shared component file. Register it explicitly in ${REGISTRY_PATH}.`,
        });
      for (const name of scan.components)
        if (!registry.components[scan.file]?.includes(name))
          errors.push({
            file: scan.file,
            line: 1,
            rule: 'component-symbol',
            message: `New UI component ${name}. Register it explicitly in ${REGISTRY_PATH}.`,
          });
    } else {
      const remaining = { ...(registry.legacyControls[scan.file] ?? {}) };
      for (const offence of scan.offences) {
        if ((remaining[offence.fingerprint] ?? 0) > 0) remaining[offence.fingerprint]--;
        else errors.push(offence);
      }
    }
  }
  return errors;
}

/** Read only this repository's committed source tree, without a second worktree. */
export function registryAtRef(root, ref) {
  const git = (args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const files = git(['ls-tree', '-r', '--name-only', ref, '--', 'apps/mobile/sources'])
    .trim()
    .split('\n');
  // A base without the registry bootstraps only controls already committed there.
  const registryFiles = git(['ls-tree', '--name-only', ref, '--', REGISTRY_PATH]);
  if (registryFiles.trim()) return JSON.parse(git(['show', `${ref}:${REGISTRY_PATH}`]));
  const scans = files
    .filter(
      (file) =>
        /\.[jt]sx?$/.test(file) &&
        !/\.(test|spec|gen)\.[jt]sx?$|\.d\.ts$/.test(file) &&
        !/\/(test|vendor)\//.test(file),
    )
    .map((file) =>
      scanUiSource(git(['show', `${ref}:${file}`]), file.replace('apps/mobile/sources/', '')),
    );
  return grandfatherRegistry(scans);
}
