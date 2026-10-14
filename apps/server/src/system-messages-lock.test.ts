import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const server = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = resolve(server, 'system-messages.lock.json');
const failure =
  "New or changed System message. Only lunchboxfortwo can approve System messages. Remove it, or get lunchboxfortwo's approval and update apps/server/system-messages.lock.json.";
type Entry = {
  id: string;
  file: string;
  kind: string;
  template: string;
  literals: string[];
  occurrences: number;
};
const printer = ts.createPrinter({ removeComments: true });
const print = (node: ts.Node) =>
  printer.printNode(ts.EmitHint.Unspecified, node, node.getSourceFile());

function sources(directory: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) for (const pair of sources(path)) files.set(...pair);
    else if (
      /\.[cm]?[jt]sx?$/.test(entry.name) &&
      !/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name) &&
      entry.name !== 'test-support.ts'
    )
      files.set(path, readFileSync(path, 'utf8'));
  }
  return files;
}

/** Parse symbols, not source substrings: aliases and wrappers retain their sink identity. */
function scan(files: Map<string, string>): Entry[] {
  const options: ts.CompilerOptions = {
    noLib: true,
    allowJs: true,
    noResolve: false,
    target: ts.ScriptTarget.ESNext,
  };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (path) =>
    files.has(path)
      ? ts.createSourceFile(path, files.get(path)!, ts.ScriptTarget.Latest, true)
      : undefined;
  host.fileExists = (path) => files.has(path);
  host.readFile = (path) => files.get(path);
  host.resolveModuleNames = (names, containing) =>
    names.map((name) => {
      const path = resolve(dirname(containing), name.replace(/\.js$/, '.ts'));
      return files.has(path) ? { resolvedFileName: path, extension: ts.Extension.Ts } : undefined;
    });
  const program = ts.createProgram([...files.keys()], options, host);
  const checker = program.getTypeChecker();
  const symbol = (node: ts.Node): ts.Symbol | undefined => {
    let value =
      ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node) ? node.name : node);
    if (value && value.flags & ts.SymbolFlags.Alias) value = checker.getAliasedSymbol(value);
    return value;
  };
  const declarations = (node: ts.Node) => symbol(node)?.declarations ?? [];
  const functions = new Map<ts.Node, ts.Node>();
  const calls: ts.CallExpression[] = [];
  const cards: ts.ObjectLiteralExpression[] = [];
  const owners = new Map<ts.Node, ts.Node | undefined>();
  const visit = (node: ts.Node, owner?: ts.Node) => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node)
    ) {
      owner = node;
      functions.set(node, node);
      if (ts.isVariableDeclaration(node.parent)) functions.set(node.parent, node);
    }
    if (ts.isCallExpression(node)) {
      calls.push(node);
      owners.set(node, owner);
    }
    if (
      ts.isObjectLiteralExpression(node) &&
      node.properties.some(
        (property) =>
          ts.isPropertyAssignment(property) &&
          (/^(cardType|card_type)$/.test(property.name.getText()) ||
            (property.name.getText() === 'presentation' &&
              /^(?:'|\")(system|card)(?:'|\")$/.test(print(property.initializer)))),
      )
    ) {
      cards.push(node);
      owners.set(node, owner);
    }
    ts.forEachChild(node, (child) => visit(child, owner));
  };
  for (const file of program.getSourceFiles()) visit(file);
  const privateReport = (call: ts.CallExpression) => {
    const options = call.arguments[6];
    if (!options || !ts.isObjectLiteralExpression(options)) return false;
    for (const property of [...options.properties].reverse()) {
      if (ts.isSpreadAssignment(property)) return false;
      if (ts.isPropertyAssignment(property) && property.name.getText() === 'agentOnly')
        return property.initializer.kind === ts.SyntaxKind.TrueKeyword;
    }
    return false;
  };
  const targets = (node: ts.Node, name: string, seen = new Set<ts.Node>()): boolean => {
    if (seen.has(node)) return false;
    seen.add(node);
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      /^(bind|call|apply)$/.test(node.expression.name.text)
    )
      return targets(node.expression.expression, name, seen);
    if (ts.isPropertyAccessExpression(node) && /^(bind|call|apply)$/.test(node.name.text))
      return targets(node.expression, name, seen);
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === name
    )
      return true;
    if (symbol(node)?.name === name || node.getText().split('.').at(-1) === name) return true;
    return declarations(node).some(
      (declaration) =>
        ((ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration)) &&
          !!declaration.initializer &&
          targets(declaration.initializer, name, seen)) ||
        (ts.isBindingElement(declaration) && declaration.propertyName?.getText() === name),
    );
  };
  const named = (call: ts.CallExpression, name: string) => targets(call.expression, name);
  const sqlText = (node: ts.Node, seen = new Set<ts.Node>()): string => {
    if (seen.has(node)) return '';
    seen.add(node);
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    )
      return node.text;
    if (ts.isCallExpression(node)) {
      // A query result is not SQL. Only follow a builder's returned expression.
      return declarations(node.expression)
        .flatMap((declaration) => {
          if (!ts.isFunctionDeclaration(declaration) || !declaration.body) return [];
          const results: string[] = [];
          const returns = (part: ts.Node) => {
            if (ts.isReturnStatement(part) && part.expression)
              results.push(sqlText(part.expression, seen));
            else ts.forEachChild(part, returns);
          };
          returns(declaration.body);
          return results;
        })
        .join(' ');
    }
    if (ts.isPropertyAccessExpression(node))
      return declarations(node)
        .map((declaration) =>
          ts.isPropertyAssignment(declaration) ? sqlText(declaration.initializer, seen) : '',
        )
        .join(' ');
    if (ts.isIdentifier(node))
      return declarations(node)
        .map((declaration) =>
          ts.isVariableDeclaration(declaration) && declaration.initializer
            ? sqlText(declaration.initializer, seen)
            : ts.isFunctionDeclaration(declaration) && declaration.body
              ? sqlText(declaration.body, seen)
              : '',
        )
        .join(' ');
    const pieces: string[] = [];
    ts.forEachChild(node, (child) => {
      pieces.push(sqlText(child, seen));
    });
    return pieces.join('');
  };
  const direct = new Map<ts.Node, string>();
  for (const file of program.getSourceFiles()) {
    const tagged = (node: ts.Node) => {
      if (
        ts.isTaggedTemplateExpression(node) &&
        /\b(?:INSERT\s+INTO|UPDATE)\s+(?:"?public"?\s*\.\s*)?messages\b/i.test(
          sqlText(node.template),
        )
      )
        direct.set(node, 'message-write');
      ts.forEachChild(node, tagged);
    };
    tagged(file);
  }
  for (const call of calls) {
    if (named(call, 'systemLine')) direct.set(call, 'systemLine');
    else if (named(call, 'restateSystemLine')) direct.set(call, 'restateSystemLine');
    else if (named(call, 'reportToCommander') && !privateReport(call))
      direct.set(call, 'reportToCommander');
    else if (
      call.arguments[0] &&
      /\b(?:INSERT\s+INTO|UPDATE)\s+(?:"?public"?\s*\.\s*)?["`]?messages\b/i.test(
        sqlText(call.arguments[0]),
      )
    )
      direct.set(call, 'message-write');
  }
  for (const card of cards) if (!direct.has(card.parent)) direct.set(card, 'system-card');
  // Track the parameters that feed phrase input, rather than every caller of a
  // function that happens to emit a notice. This follows forwarding helpers
  // without freezing unrelated control flow such as a voice heartbeat.
  const wrappers = new Map<ts.Node, Set<number>>();
  const phraseParts = (node: ts.Node): ts.Node[] =>
    ts.isObjectLiteralExpression(node)
      ? node.properties.flatMap((property) =>
          ts.isSpreadAssignment(property)
            ? [property.expression]
            : ts.isShorthandPropertyAssignment(property)
              ? [property.name]
              : ts.isPropertyAssignment(property) &&
                  /^(subject|verb|object|consequence|text|card|cardType|card_type)$/.test(
                    property.name.getText(),
                  )
                ? [property.initializer]
                : [],
        )
      : [node];
  const forward = (node: ts.Node, parts: readonly ts.Node[]) => {
    const owner = owners.get(node);
    if (!owner || !ts.isFunctionLike(owner)) return false;
    const parameters = owner.parameters;
    const indices = wrappers.get(owner) ?? new Set<number>();
    const size = indices.size;
    const seen = new Set<ts.Node>();
    const inspect = (part: ts.Node) => {
      if (seen.has(part)) return;
      seen.add(part);
      if (ts.isIdentifier(part))
        for (const declaration of declarations(part)) {
          const index = parameters.findIndex((parameter) => parameter === declaration);
          if (index >= 0) indices.add(index);
          if (ts.isVariableDeclaration(declaration) && declaration.initializer)
            inspect(declaration.initializer);
        }
      ts.forEachChild(part, inspect);
    };
    parts.forEach(inspect);
    if (indices.size) wrappers.set(owner, indices);
    return indices.size !== size;
  };
  for (const [node, kind] of direct) {
    if (!ts.isCallExpression(node)) {
      forward(node, phraseParts(node));
      continue;
    }
    const call = node;
    const parts =
      kind === 'restateSystemLine'
        ? call.arguments[2]
          ? phraseParts(call.arguments[2])
          : []
        : kind === 'systemLine'
          ? call.arguments[1]
            ? phraseParts(call.arguments[1])
            : []
          : kind === 'reportToCommander'
            ? call.arguments.slice(3, 4)
            : /INSERT\s+INTO/i.test(sqlText(call.arguments[0]!))
              ? call.arguments.slice(1)
              : [];
    forward(node, parts);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const call of calls) {
      if (named(call, 'reportToCommander') && privateReport(call)) continue;
      const indices = new Set(
        declarations(call.expression).flatMap((declaration) => [
          ...(wrappers.get(functions.get(declaration) ?? declaration) ?? []),
        ]),
      );
      if (!indices.size) continue;
      if (!direct.has(call)) direct.set(call, 'wrapper');
      if (
        forward(
          call,
          [...indices].flatMap((index) => (call.arguments[index] ? [call.arguments[index]!] : [])),
        )
      )
        changed = true;
    }
  }

  const entries = new Map<string, Entry>();
  for (const [node, kind] of direct) {
    const file = relative(server, node.getSourceFile().fileName).replaceAll('\\', '/');
    const template = print(node);
    const scope: string[] = [];
    for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent)
      if (
        (ts.isFunctionDeclaration(parent) ||
          ts.isMethodDeclaration(parent) ||
          ts.isClassDeclaration(parent)) &&
        parent.name
      )
        scope.unshift(parent.name.getText());
    const id = `${file}:${scope.join('.') || 'module'}:${kind}:${createHash('sha256').update(template).digest('hex').slice(0, 16)}`;
    const literals = new Set<string>();
    const seen = new Set<ts.Node>();
    const collect = (part: ts.Node) => {
      if (seen.has(part)) return;
      seen.add(part);
      if (ts.isStringLiteralLike(part) || ts.isTemplateExpression(part)) literals.add(print(part));
      if (
        (ts.isIdentifier(part) || ts.isPropertyAccessExpression(part)) &&
        !(ts.isPropertyAccessExpression(part.parent) && part.parent.name === part) &&
        !(ts.isPropertyAssignment(part.parent) && part.parent.name === part)
      ) {
        for (const declaration of declarations(part)) {
          if (!files.has(declaration.getSourceFile().fileName)) continue;
          if (ts.isVariableDeclaration(declaration) && declaration.initializer)
            collect(declaration.initializer);
          if (ts.isBindingElement(declaration)) {
            let parent: ts.Node = declaration;
            while (parent.parent && !ts.isVariableDeclaration(parent)) parent = parent.parent;
            if (ts.isVariableDeclaration(parent) && parent.initializer) collect(parent.initializer);
          }
          if (ts.isPropertyAssignment(declaration)) collect(declaration.initializer);
          // Formatting helpers carry literal phrases in their bodies, including imported helpers.
          if (
            (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) &&
            declaration.body &&
            !wrappers.has(declaration)
          )
            collect(declaration.body);
        }
      }
      ts.forEachChild(part, collect);
    };
    // The database argument is transport, not a phrase dependency.
    if (ts.isCallExpression(node) && kind === 'systemLine')
      node.arguments.slice(1).forEach(collect);
    else if (ts.isCallExpression(node) && kind === 'restateSystemLine')
      node.arguments.slice(2).forEach(collect);
    else if (ts.isCallExpression(node) && kind === 'reportToCommander')
      node.arguments.slice(3, 4).forEach(collect);
    else collect(node);
    const prior = entries.get(id);
    if (prior) prior.occurrences++;
    else
      entries.set(id, {
        id,
        file: `apps/server/${file}`,
        kind,
        template,
        literals: [...literals].sort(),
        occurrences: 1,
      });
  }
  return [...entries.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function compare(current: Entry[], locked: Entry[]): { violations: string[]; removed: string[] } {
  const baseline = new Map(locked.map((entry) => [entry.id, entry]));
  const violations = current
    .filter((entry) => {
      const prior = baseline.get(entry.id);
      return (
        !prior ||
        entry.template !== prior.template ||
        JSON.stringify(entry.literals) !== JSON.stringify(prior.literals) ||
        entry.occurrences > prior.occurrences
      );
    })
    .map((entry) => `${entry.file}: ${entry.id}`);
  const live = new Set(current.map((entry) => entry.id));
  return {
    violations,
    removed: locked.filter((entry) => !live.has(entry.id)).map((entry) => entry.id),
  };
}

function enforce(current: Entry[], locked: Entry[]): void {
  const result = compare(current, locked);
  if (result.removed.length)
    console.info(
      'Removed System message producers; delete their snapshot entries:\n' +
        result.removed.join('\n'),
    );
  if (result.violations.length) throw new Error(failure + '\n' + result.violations.join('\n'));
}

it('freezes System message producers and literal templates against the owner-reviewed lock', () => {
  const current = scan(sources(resolve(server, 'src')));
  const locked = JSON.parse(readFileSync(lockPath, 'utf8')) as Entry[];
  enforce(current, locked);
}, 30_000);

function fixture(extra = '', phrase = 'joined') {
  return new Map([
    ['/fixtures/system-line.ts', 'export function systemLine(db: unknown, input: unknown) {}'],
    [
      '/fixtures/producer.ts',
      `import { systemLine as line } from './system-line.js';\nconst phrase = '${phrase}';\nexport function existing(db: unknown) { return line(db, { verb: phrase }); }\n${extra}`,
    ],
  ]);
}

it('rejects a newly added aliased systemLine producer', () => {
  const baseline = scan(fixture());
  const result = compare(
    scan(
      fixture(
        "export function added(db: unknown) { return line(db, { verb: 'invented a notice' }); }",
      ),
    ),
    baseline,
  );
  expect(result.violations).toHaveLength(1);
  expect(() =>
    enforce(
      scan(
        fixture(
          "export function added(db: unknown) { return line(db, { verb: 'invented a notice' }); }",
        ),
      ),
      baseline,
    ),
  ).toThrow(failure);
  console.info('Demonstrated System message freeze: new systemLine fixture rejected');
});

it('rejects a changed existing template, including a referenced constant', () => {
  expect(compare(scan(fixture('', 'left')), scan(fixture())).violations).toHaveLength(1);
  expect(() => enforce(scan(fixture('', 'left')), scan(fixture()))).toThrow(failure);
  console.info('Demonstrated System message freeze: changed template fixture rejected');
});

it('allows removal and asks for the obsolete snapshot entry to be deleted', () => {
  const files = fixture();
  files.set('/fixtures/producer.ts', '');
  const result = compare(scan(files), scan(fixture()));
  expect(result.violations).toEqual([]);
  expect(result.removed).toHaveLength(1);
});

it('rejects templates added through a forwarding wrapper', () => {
  const base = fixture('function note(db: unknown, phrase: unknown) { return line(db, phrase); }');
  const changed = new Map(base);
  changed.set(
    '/fixtures/producer.ts',
    base.get('/fixtures/producer.ts')! +
      "\nexport function added(db: unknown) { return note(db, { verb: 'new wrapper message' }); }",
  );
  expect(compare(scan(changed), scan(base)).violations.length).toBeGreaterThan(0);
});

it.each([
  "db.query('INSERT INTO messages(id,author_id,text) VALUES($1,$2,$3)', ['id', SYSTEM_IDENTITY_ID, 'new direct post']);",
  "const sql = 'INSERT INTO messages(id,author_id,text) VALUES($1,$2,$3)'; db.query(sql, ['id', SYSTEM_IDENTITY_ID, 'new indirect post']);",
  "const write = line; const alias = write; alias(db, { verb: 'new aliased message' });",
  "restateSystemLine(db, 'id', {verb: 'new restatement'});",
  "db.send({ presentation: 'card', text: 'new card' });",
  "db.sql`INSERT INTO messages(text) VALUES('new tagged post')`;",
  "const table='messages'; db.query(`INSERT INTO public.${table}(text) VALUES($1)`, ['new interpolated post']);",
  "reportToCommander(db, room, SYSTEM_IDENTITY_ID, 'new report');",
])('rejects another producer syntax: %s', (statement) => {
  const baseline = fixture();
  const changed = fixture(`export function added(db: any) { ${statement} }`);
  expect(compare(scan(changed), scan(baseline)).violations.length).toBeGreaterThan(0);
});

it('does not treat an overridable agentOnly flag as a private report', () => {
  const changed = fixture(
    "export function added(db: any, options: any) { reportToCommander(db, room, SYSTEM_IDENTITY_ID, 'new public report', undefined, 'id', {agentOnly: true, ...options}); }",
  );
  expect(compare(scan(changed), scan(fixture())).violations.length).toBeGreaterThan(0);
});

it('keeps a statically private report outside the visible-message lock', () => {
  const changed = fixture(
    "export function privateWake(db: any) { reportToCommander(db, room, SYSTEM_IDENTITY_ID, 'private wake', undefined, 'id', {agentOnly: true}); }",
  );
  expect(compare(scan(changed), scan(fixture())).violations).toEqual([]);
});

it('rejects a changed phrase read from an object property', () => {
  const base = fixture();
  const changed = fixture();
  base.set(
    '/fixtures/producer.ts',
    "import {systemLine} from './system-line.js'; const phrases = {verb:'joined'}; systemLine(db,{verb:phrases.verb});",
  );
  changed.set(
    '/fixtures/producer.ts',
    base.get('/fixtures/producer.ts')!.replace("verb:'joined'", "verb:'left'"),
  );
  expect(() => enforce(scan(changed), scan(base))).toThrow(failure);
});

it('rejects a new phrase passed through a System card helper', () => {
  const base = fixture("function card(text: string) { return {presentation:'card',text}; }");
  const changed = fixture(
    "function card(text: string) { return {presentation:'card',text}; } card('new card');",
  );
  expect(() => enforce(scan(changed), scan(base))).toThrow(failure);
});
