// Do not delete, disable or modify this guard or its list without lunchboxfortwo's express command.
// Protect user-facing System messages; proven agent-only delivery stays outside the lock.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';

const server = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = resolve(server, 'system-messages.lock.jsonc');
const failure =
  "New or changed System message. Only lunchboxfortwo can approve System messages. Remove it, or get lunchboxfortwo's approval and update apps/server/system-messages.lock.jsonc.";
type Entry = {
  id: string;
  file: string;
  kind: string;
  /** Review context only; hidden data and expression names do not gate wording. */
  template: string;
  literals: string[];
  occurrences: number;
};
const printer = ts.createPrinter({ removeComments: true });

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

// A fixture may reuse a path with different contents. Cache each exact version,
// never just its path, so mutations still receive their own syntax tree.
const parsedSources = new Map<string, Map<string, ts.SourceFile>>();
function parsedSource(path: string, text: string): ts.SourceFile {
  let versions = parsedSources.get(path);
  if (!versions) parsedSources.set(path, versions = new Map());
  let source = versions.get(text);
  if (!source) {
    source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    versions.set(text, source);
  }
  return source;
}

// Reuse analysis only when the entire input graph (including order) is identical.
// Changed imports, removed files and changed dependency text all require a scan.
const scannedSources = new Map<string, Entry[]>();

/** Parse symbols, not source substrings: aliases and wrappers retain their sink identity. */
function scan(files: Map<string, string>): Entry[] {
  const key = createHash('sha256').update(JSON.stringify([...files])).digest('hex');
  const cached = scannedSources.get(key);
  if (cached) return cached;
  const options: ts.CompilerOptions = {
    noLib: true,
    allowJs: true,
    noResolve: false,
    target: ts.ScriptTarget.ESNext,
  };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (path) =>
    files.has(path)
      ? parsedSource(path, files.get(path)!)
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
  // Semantic lookups belong to this checker: a reused syntax tree can resolve
  // differently when another file in the program changes.
  const symbols = new Map<ts.Node, ts.Symbol | undefined>();
  const symbol = (node: ts.Node): ts.Symbol | undefined => {
    if (symbols.has(node)) return symbols.get(node);
    let value =
      ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node) ? node.name : node);
    if (value && value.flags & ts.SymbolFlags.Alias) value = checker.getAliasedSymbol(value);
    symbols.set(node, value);
    return value;
  };
  const declarationCache = new Map<ts.Node, readonly ts.Declaration[]>();
  const declarations = (node: ts.Node): readonly ts.Declaration[] => {
    const cached = declarationCache.get(node);
    if (cached) return cached;
    const value = symbol(node)?.declarations ?? [];
    declarationCache.set(node, value);
    return value;
  };
  const functions = new Map<ts.Node, ts.Node>();
  const calls: ts.CallExpression[] = [];
  const cards: ts.ObjectLiteralExpression[] = [];
  const owners = new Map<ts.Node, ts.Node | undefined>();
  const mutations = new Map<ts.Symbol, ts.Node[]>();
  const rememberMutation = (target: ts.Node, values: readonly ts.Node[]) => {
    while (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target))
      target = target.expression;
    const key = symbol(target);
    if (key) mutations.set(key, [...(mutations.get(key) ?? []), ...values]);
  };
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
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    )
      rememberMutation(node.left, [node.right]);
    if (ts.isCallExpression(node)) {
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        /^(push|unshift|splice|set|add)$/.test(node.expression.name.text)
      )
        rememberMutation(node.expression.expression, node.arguments);
      calls.push(node);
      owners.set(node, owner);
    }
    if (
      ts.isObjectLiteralExpression(node) &&
      node.properties.some(
        (property) =>
          (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
          (/^(cardType|card_type)$/.test(property.name.getText()) ||
            property.name.getText() === 'presentation'),
      )
    ) {
      cards.push(node);
      owners.set(node, owner);
    }
    ts.forEachChild(node, (child) => visit(child, owner));
  };
  for (const file of program.getSourceFiles()) visit(file);
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
    const local = checker.getSymbolAtLocation(node);
    if (
      local?.declarations?.some(
        (declaration) =>
          ts.isImportSpecifier(declaration) &&
          (declaration.propertyName ?? declaration.name).text === name,
      )
    )
      return true;
    return declarations(node).some(
      (declaration) =>
        ((ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration)) &&
          !!declaration.initializer &&
          targets(declaration.initializer, name, seen)) ||
        (ts.isBindingElement(declaration) && declaration.propertyName?.getText() === name),
    );
  };
  const queryResults = new Map<ts.Node, boolean>();
  const queryResult = (node: ts.Node) => {
    const cached = queryResults.get(node);
    if (cached !== undefined) return cached;
    const target = ts.isCallExpression(node)
      ? node.expression
      : ts.isTaggedTemplateExpression(node)
        ? node.tag
        : undefined;
    const result = !!target && ['query', 'sql', 'execute'].some((name) => targets(target, name));
    queryResults.set(node, result);
    return result;
  };
  const templatePrint = (node: ts.Node) => {
    const transformed = ts.transform(node, [
      (context) => (root) => {
        const visit = (part: ts.Node): ts.Node =>
          queryResult(part)
            ? ts.factory.createIdentifier('$databaseResult')
            : ts.visitEachChild(part, visit, context);
        return ts.visitNode(root, visit) as typeof root;
      },
    ]);
    const text = printer.printNode(
      ts.EmitHint.Unspecified,
      transformed.transformed[0]!,
      node.getSourceFile(),
    );
    transformed.dispose();
    return text;
  };
  const callableDeclarations = (node: ts.Node, seen = new Set<ts.Node>()): ts.Node[] => {
    if (seen.has(node)) return [];
    seen.add(node);
    if (
      (ts.isCallExpression(node) || ts.isPropertyAccessExpression(node)) &&
      ts.isPropertyAccessExpression(ts.isCallExpression(node) ? node.expression : node) &&
      /^(bind|call|apply)$/.test(
        (ts.isCallExpression(node) ? node.expression : node).getText().split('.').at(-1)!,
      )
    ) {
      const access = (
        ts.isCallExpression(node) ? node.expression : node
      ) as ts.PropertyAccessExpression;
      return callableDeclarations(access.expression, seen);
    }
    return declarations(node).flatMap((declaration) => [
      declaration,
      ...((ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration)) &&
      declaration.initializer
        ? callableDeclarations(declaration.initializer, seen)
        : []),
    ]);
  };
  const named = (call: ts.CallExpression, name: string) => targets(call.expression, name);
  // Resolve invocation adapters before selecting phrase-bearing parameters.
  const invocationArguments = (call: ts.CallExpression): readonly ts.Node[] => {
    const array = (node: ts.Node | undefined, seen = new Set<ts.Node>()): readonly ts.Node[] => {
      if (!node || seen.has(node)) return [];
      seen.add(node);
      if (ts.isArrayLiteralExpression(node))
        return node.elements.flatMap((element) =>
          ts.isSpreadElement(element) ? array(element.expression, seen) : [element],
        );
      for (const declaration of declarations(node))
        if (ts.isVariableDeclaration(declaration) && declaration.initializer)
          return array(declaration.initializer, seen);
      return [];
    };
    const resolve = (
      target: ts.Node,
      args: readonly ts.Node[],
      seen = new Set<ts.Node>(),
    ): readonly ts.Node[] => {
      if (seen.has(target)) return args;
      seen.add(target);
      if (ts.isPropertyAccessExpression(target) && /^(bind|call|apply)$/.test(target.name.text))
        return resolve(
          target.expression,
          target.name.text === 'apply' ? array(args[1]) : args.slice(1),
          seen,
        );
      if (
        ts.isCallExpression(target) &&
        ts.isPropertyAccessExpression(target.expression) &&
        target.expression.name.text === 'bind'
      )
        return resolve(target.expression.expression, [...target.arguments.slice(1), ...args], seen);
      for (const declaration of declarations(target))
        if (
          (ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration)) &&
          declaration.initializer
        )
          return resolve(declaration.initializer, args, seen);
      return args;
    };
    return resolve(call.expression, call.arguments);
  };
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
  const sqlTokens = (text: string) =>
    (
      text.match(
        /--[^\n]*|\/\*[\s\S]*?\*\/|(\$(?:[A-Za-z_]\w*)?\$)[\s\S]*?\1|'(?:''|[^'])*'|"(?:""|[^"])*"|\$\d+|__expression_\d+__|[a-zA-Z_][\w]*|::|[^\s]/g,
      ) ?? []
    ).filter((token) => !token.startsWith('--') && !token.startsWith('/*'));
  const wordingTokens = (tokens: string[], initially = false): string[] => {
    const projections = new Map<number, boolean>(initially ? [[0, true]] : []);
    const predicates = new Set<number>();
    const exists = new Set<number>();
    const conditions: boolean[] = [];
    const selected: string[] = [];
    let depth = 0;
    let startsExists = false;
    for (const token of tokens) {
      if (token.startsWith('--') || token.startsWith('/*')) continue;
      if (token === '(') {
        depth++;
        if (startsExists) exists.add(depth);
        startsExists = false;
      }
      if (token === ')') {
        projections.delete(depth);
        predicates.delete(depth);
        exists.delete(depth--);
      }
      if (/^exists$/i.test(token)) startsExists = true;
      if (/^(select|values|set|returning)$/i.test(token)) {
        projections.set(depth, true);
        predicates.delete(depth);
      }
      if (/^(where|on|having|for)$/i.test(token)) predicates.add(depth);
      if (
        projections.has(depth) &&
        /^(from|where|join|on|group|having|order|limit|offset|union|intersect|except|for)$/i.test(
          token,
        )
      )
        projections.set(depth, false);
      const active = [...projections]
        .filter(([level]) => level <= depth)
        .sort(([a], [b]) => b - a)[0]?.[1];
      if (/^case$/i.test(token)) conditions.push(true);
      if (/^when$/i.test(token) && conditions.length) conditions[conditions.length - 1] = true;
      if (/^(then|else)$/i.test(token) && conditions.length)
        conditions[conditions.length - 1] = false;
      if (/^end$/i.test(token)) conditions.pop();
      if (!active || predicates.size || exists.size || conditions.some(Boolean)) continue;
      selected.push(token);
    }
    return selected;
  };
  // A query reached through returned phrase data can supply wording. Track
  // SELECT, VALUES, SET and RETURNING expressions, excluding access predicates.
  const queryWordingUncached = (node: ts.Node): { literals: string[]; parts: ts.Node[] } => {
    const expressions: ts.Node[] = [];
    const render = (part: ts.Node, seen = new Set<ts.Node>()): string => {
      if (seen.has(part)) return '';
      seen.add(part);
      if (ts.isStringLiteralLike(part)) return part.text;
      if (ts.isTemplateExpression(part))
        return (
          part.head.text +
          part.templateSpans
            .map((span) => {
              // Query strings interpolate SQL syntax; tagged queries bind values.
              const fragment = ts.isCallExpression(node) ? sqlText(span.expression) : '';
              return (
                (fragment || `__expression_${expressions.push(span.expression) - 1}__`) +
                span.literal.text
              );
            })
            .join('')
        );
      for (const declaration of declarations(part))
        if (ts.isVariableDeclaration(declaration) && declaration.initializer)
          return render(declaration.initializer, seen);
      return sqlText(part);
    };
    const array = (part: ts.Node | undefined, seen = new Set<ts.Node>()): readonly ts.Node[] => {
      if (!part || seen.has(part)) return [];
      seen.add(part);
      if (ts.isArrayLiteralExpression(part)) return part.elements;
      for (const declaration of declarations(part))
        if (ts.isVariableDeclaration(declaration) && declaration.initializer)
          return array(declaration.initializer, seen);
      return [];
    };
    const query = ts.isCallExpression(node)
      ? node.arguments[0]
      : ts.isTaggedTemplateExpression(node)
        ? node.template
        : undefined;
    if (!query) return { literals: [], parts: [] };
    const parameters = ts.isCallExpression(node) ? array(node.arguments[1]) : [];
    const queryText = render(query);
    // Command rows are transport receipts. Their INSERT values (depth, wake
    // context and private payload) are not returned System phrase expressions.
    // Explicit SQL phrase projections remain locked, as do returned JS strings.
    let commandOwner: ts.Node | undefined = node;
    while (commandOwner && !ts.isFunctionDeclaration(commandOwner)) commandOwner = commandOwner.parent;
    if (commandOwner && ts.isFunctionDeclaration(commandOwner) &&
        commandOwner.name?.text === 'createAgentCommand' &&
        commandOwner.getSourceFile().fileName === resolve(server, 'src/agent-command.ts') &&
        /\b(?:FROM|INTO)\s+agent_commands\b/i.test(queryText) &&
        /\b(?:SELECT|RETURNING)\s+\*/i.test(queryText))
      return { literals: [], parts: [] };
    const tokens = sqlTokens(queryText);
    const literals: string[] = [];
    const parts: ts.Node[] = [];
    for (const token of wordingTokens(tokens)) {
      if (token.startsWith("'") || /^\$(?:[A-Za-z_]\w*)?\$/.test(token)) literals.push(token);
      const parameter = /^\$(\d+)$/.exec(token);
      const expression = /^__expression_(\d+)__$/.exec(token);
      const value = parameter
        ? parameters[Number(parameter[1]) - 1]
        : expression
          ? expressions[Number(expression[1])]
          : undefined;
      if (value) parts.push(value);
    }
    return { literals, parts };
  };
  const queryWords = new Map<ts.Node, { literals: string[]; parts: ts.Node[] }>();
  const queryWording = (node: ts.Node) => {
    let result = queryWords.get(node);
    if (!result) queryWords.set(node, result = queryWordingUncached(node));
    return result;
  };
  const systemPresentation = (node: ts.Node, seen = new Set<ts.Node>()): boolean => {
    if (seen.has(node)) return false;
    seen.add(node);
    if (ts.isStringLiteralLike(node)) return node.text === 'system' || node.text === 'card';
    if (
      declarations(node).some(
        (declaration) =>
          ts.isVariableDeclaration(declaration) &&
          !!declaration.initializer &&
          systemPresentation(declaration.initializer, seen),
      )
    )
      return true;
    return node.getChildren().some((child) => systemPresentation(child, seen));
  };
  // SQL is transport. Keep only assigned message values, resolving parameters
  // back to their expressions; predicates and other CTEs never supply wording.
  const writes = new Map<ts.Node, { template: string; parts: ts.Node[]; literals: string[] }>();
  const sqlWrite = (node: ts.Node, query: ts.Node, values?: ts.Node) => {
    const expressions: ts.Node[] = [];
    const render = (part: ts.Node, seen = new Set<ts.Node>()): string => {
      if (seen.has(part)) return '';
      seen.add(part);
      if (ts.isStringLiteralLike(part)) return part.text;
      if (ts.isTemplateExpression(part))
        return (
          part.head.text +
          part.templateSpans
            .map((span) => {
              const index = expressions.push(span.expression) - 1;
              return `__expression_${index}__` + span.literal.text;
            })
            .join('')
        );
      for (const declaration of declarations(part)) {
        if (ts.isVariableDeclaration(declaration) && declaration.initializer)
          return render(declaration.initializer, seen);
      }
      return sqlText(part);
    };
    const text = render(query);
    if (
      !/\b(?:INSERT\s+INTO|UPDATE)\s+(?:"?public"?\s*\.\s*)?["`]?messages\b/i.test(sqlText(query))
    )
      return;
    const array = (
      part: ts.Node | undefined,
      seen = new Set<ts.Node>(),
    ): readonly ts.Expression[] => {
      if (!part || seen.has(part)) return [];
      seen.add(part);
      if (ts.isArrayLiteralExpression(part)) return part.elements;
      for (const declaration of declarations(part))
        if (ts.isVariableDeclaration(declaration) && declaration.initializer)
          return array(declaration.initializer, seen);
      return [];
    };
    const parameters = array(values);
    const tokens = sqlTokens(text);
    const lower = (token: string | undefined) => {
      const expression = token && /^__expression_(\d+)__$/.exec(token);
      return (expression ? sqlText(expressions[Number(expression[1])]!) : token)
        ?.replaceAll('"', '')
        .toLowerCase();
    };
    const parts: ts.Node[] = [];
    const outputs: string[] = [];
    const sqlLiterals: string[] = [];
    const project = (tokens: string[], capture = false): string =>
      tokens
        .map((token) => {
          if (capture && (token.startsWith("'") || /^\$(?:[A-Za-z_]\w*)?\$/.test(token)))
            sqlLiterals.push(token);
          const parameter = /^\$(\d+)$/.exec(token);
          const expression = /^__expression_(\d+)__$/.exec(token);
          const value = parameter
            ? parameters[Number(parameter[1]) - 1]
            : expression
              ? expressions[Number(expression[1])]
              : undefined;
          if (value) {
            if (capture) parts.push(value);
            return templatePrint(value);
          }
          return token;
        })
        .join(' ');
    // Use the same output/predicate distinction for direct message writes.
    const wording = (tokens: string[]) => wordingTokens(tokens, true);
    const group = (start: number, stops: Set<string>, closing = false) => {
      const groups: string[][] = [[]];
      let depth = 0;
      let index = start;
      for (; index < tokens.length; index++) {
        const token = tokens[index]!;
        if (!depth && ((closing && token === ')') || stops.has(lower(token)!))) break;
        if (!depth && token === ',') groups.push([]);
        else {
          groups.at(-1)!.push(token);
          if (token === '(') depth++;
          if (token === ')') depth--;
        }
      }
      return { groups, end: index };
    };
    for (let index = 0; index < tokens.length; index++) {
      const insert = lower(tokens[index]) === 'insert' && lower(tokens[index + 1]) === 'into';
      const update = lower(tokens[index]) === 'update';
      if (!insert && !update) continue;
      let table = index + (insert ? 2 : 1);
      if (lower(tokens[table]) === 'public' && tokens[table + 1] === '.') table += 2;
      if (lower(tokens[table]) !== 'messages') continue;
      const rows = [new Map<string, string[]>()];
      const fields = rows[0]!;
      if (insert) {
        if (tokens[table + 1] !== '(') continue;
        const columns = group(table + 2, new Set(), true);
        const mode = lower(tokens[columns.end + 1]);
        if (mode !== 'values' && mode !== 'select') continue;
        const row = group(
          columns.end + (mode === 'values' ? 3 : 2),
          new Set(['from', 'where', 'returning', 'on']),
          mode === 'values',
        );
        columns.groups.forEach((column, position) => {
          fields.set(lower(column[0])!, row.groups[position] ?? []);
        });
        let end = row.end;
        while (mode === 'values' && tokens[end + 1] === ',' && tokens[end + 2] === '(') {
          const next = group(end + 3, new Set(), true);
          rows.push(
            new Map(
              columns.groups.map((column, position) => [
                lower(column[0])!,
                next.groups[position] ?? [],
              ]),
            ),
          );
          end = next.end;
        }
        for (let position = end; position < tokens.length - 3; position++) {
          if (
            lower(tokens[position]) !== 'do' ||
            lower(tokens[position + 1]) !== 'update' ||
            lower(tokens[position + 2]) !== 'set'
          )
            continue;
          const conflict = new Map(fields);
          for (const assignment of group(position + 3, new Set(['where', 'returning']), true)
            .groups) {
            const equals = assignment.indexOf('=');
            if (equals > 0)
              conflict.set(lower(assignment[equals - 1])!, assignment.slice(equals + 1));
          }
          rows.push(conflict);
          break;
        }
      } else {
        let set = table + 1;
        while (set < tokens.length && lower(tokens[set]) !== 'set') set++;
        const assignments = group(set + 1, new Set(['where', 'from', 'returning']), true);
        for (const assignment of assignments.groups) {
          const equals = assignment.indexOf('=');
          if (equals > 0) fields.set(lower(assignment[equals - 1])!, assignment.slice(equals + 1));
        }
      }
      for (const fields of rows) {
        for (const [name, tokens] of fields) {
          if (tokens.join('') === name || tokens.join('').match(new RegExp(`^\\w+\\.${name}$`)))
            fields.delete(name);
        }
        const assigned = (name: string, capture = false) =>
          project(capture ? wording(fields.get(name) ?? []) : (fields.get(name) ?? []), capture);
        // Resolve aliases/constants through the same symbol graph used by phrase collection.
        const systemAuthor = (part: ts.Node, seen = new Set<ts.Node>()): boolean => {
          if (seen.has(part)) return false;
          seen.add(part);
          if (
            targets(part, 'SYSTEM_IDENTITY_ID') ||
            (ts.isStringLiteralLike(part) && part.text === SYSTEM_IDENTITY_ID)
          )
            return true;
          if (part.getChildren().some((child) => systemAuthor(child, seen))) return true;
          return declarations(part).some(
            (declaration) =>
              ts.isVariableDeclaration(declaration) &&
              !!declaration.initializer &&
              systemAuthor(declaration.initializer, seen),
          );
        };
        const authorTokens = fields.get('author_id') ?? [];
        const authorParts = authorTokens.flatMap((token) => {
          const parameter = /^\$(\d+)$/.exec(token);
          const expression = /^__expression_(\d+)__$/.exec(token);
          const part = parameter
            ? parameters[Number(parameter[1]) - 1]
            : expression
              ? expressions[Number(expression[1])]
              : undefined;
          return part ? [part] : [];
        });
        const presentation = assigned('presentation');
        const isSystem =
          authorParts.some((part) => systemAuthor(part)) ||
          authorTokens.some((token) => token === `'${SYSTEM_IDENTITY_ID}'`) ||
          /['"](?:system|card)['"]/.test(presentation) ||
          (fields.get('presentation') ?? []).some((token) => {
            const parameter = /^\$(\d+)$/.exec(token);
            const expression = /^__expression_(\d+)__$/.exec(token);
            const value = parameter
              ? parameters[Number(parameter[1]) - 1]
              : expression
                ? expressions[Number(expression[1])]
                : undefined;
            return !!value && systemPresentation(value);
          }) ||
          (fields.has('card_type') && !/^null$/i.test(assigned('card_type')));
        const visible = [...fields.keys()].filter((name) =>
          /^(text|card|system_event)$/.test(name),
        );
        // Existing card/event updates also supply visible System wording. Human
        // edits explicitly constrained to ordinary messages stay outside the lock.
        const humanOnly = /\b(?:\w+\.)?presentation\s*=\s*'message'/i.test(text);
        if (!isSystem && (insert || !visible.length || humanOnly)) continue;
        outputs.push(
          `${insert ? 'INSERT' : 'UPDATE'} messages ` +
            [
              ...new Set([
                ...visible,
                ...['author_id', 'presentation', 'card_type'].filter((name) => fields.has(name)),
              ]),
            ]
              .map((name) => `${name}=${assigned(name, visible.includes(name))}`)
              .join(', '),
        );
      }
    }
    if (outputs.length) writes.set(node, { template: outputs.join('\n'), parts, literals: sqlLiterals });
  };
  const direct = new Map<ts.Node, string>();
  for (const file of program.getSourceFiles()) {
    const tagged = (node: ts.Node) => {
      if (ts.isTaggedTemplateExpression(node)) sqlWrite(node, node.template);
      ts.forEachChild(node, tagged);
    };
    tagged(file);
  }
  for (const call of calls) {
    if (named(call, 'systemLine')) direct.set(call, 'systemLine');
    else if (named(call, 'restateSystemLine')) direct.set(call, 'restateSystemLine');
    else if (call.arguments[0]) sqlWrite(call, call.arguments[0], call.arguments[1]);
  }
  for (const node of writes.keys()) direct.set(node, 'message-write');
  for (const card of cards)
    if (
      !direct.has(card.parent) &&
      card.properties.some(
        (property) =>
          (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
          (/^(cardType|card_type)$/.test(property.name.getText()) ||
            (property.name.getText() === 'presentation' &&
              systemPresentation(
                ts.isPropertyAssignment(property) ? property.initializer : property.name,
              ))),
      )
    )
      direct.set(card, 'system-card');
  // Track the parameters that feed phrase input, rather than every caller of a
  // function that happens to emit a notice. This follows forwarding helpers
  // without freezing unrelated control flow such as a voice heartbeat.
  const wrappers = new Map<ts.Node, Set<number>>();
  // Proven non-text metadata. Unknown keys remain wording dependencies.
  const hiddenField = (name: ts.PropertyName) =>
    (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) &&
    /^(domain|logo|appId|ownerId|roomId|messageId|id|kind|cardType|card_type|presentation)$/.test(name.text);
  const metadataOnly = (node: ts.Node, active = new Set<ts.Node>()): boolean => {
    if (active.has(node)) return false;
    active.add(node);
    try {
      if (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node))
        return metadataOnly(node.expression, active);
      if (ts.isConditionalExpression(node))
        return metadataOnly(node.whenTrue, active) && metadataOnly(node.whenFalse, active);
      if (ts.isObjectLiteralExpression(node))
        return node.properties.every((property) => ts.isSpreadAssignment(property)
          ? metadataOnly(property.expression, active)
          : (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) && hiddenField(property.name));
      if (ts.isCallExpression(node)) {
        const targets = callableDeclarations(node.expression).map((declaration) => functions.get(declaration) ?? declaration);
        return targets.length > 0 && targets.every((target) => metadataOnly(target, active));
      }
      if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        if (!node.body) return false;
        if (!ts.isBlock(node.body)) return metadataOnly(node.body, active);
        const returns: ts.Expression[] = [];
        let bareReturn = false;
        const visit = (part: ts.Node) => {
          if (ts.isReturnStatement(part)) {
            if (part.expression) returns.push(part.expression);
            else bareReturn = true;
          } else if (!ts.isFunctionLike(part)) ts.forEachChild(part, visit);
        };
        ts.forEachChild(node.body, visit);
        return !bareReturn && returns.length > 0 && returns.every((value) => metadataOnly(value, active));
      }
      return false;
    } finally { active.delete(node); }
  };
  const wordingParts = (node: ts.Node): ts.Node[] =>
    ts.isObjectLiteralExpression(node)
      ? node.properties.flatMap((property) =>
          ts.isSpreadAssignment(property)
            ? [property.expression]
            : ts.isShorthandPropertyAssignment(property)
              ? hiddenField(property.name)
                ? []
                : [property.name]
              : ts.isPropertyAssignment(property) && !hiddenField(property.name)
                ? [property.initializer]
                : [],
        )
      : [node];
  const phraseParts = (node: ts.Node): ts.Node[] =>
    ts.isObjectLiteralExpression(node)
      ? node.properties.flatMap((property) => {
          if (ts.isSpreadAssignment(property)) return [property.expression];
          if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return [];
          const name = property.name;
          const transport = (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) &&
            /^(id|roomId|authorId|kind|scheduleId|payload|subscriptionPrompt|subscriptionWorkflowSlug|wakes|presentation|cardType|card_type|requestId|commandId|durableFact|causeId|afterMessageId)$/.test(name.text);
          if (transport) return [];
          return [ts.isPropertyAssignment(property) ? property.initializer : name];
        })
      : [node];
  // A binding's container carries every possible selected value. Keep defaults
  // at every nesting level as additional origins, including rest bindings.
  const bindingOrigin = (binding: ts.BindingElement) => {
    const defaults: ts.Expression[] = [];
    let root: ts.Node = binding;
    while (ts.isBindingElement(root) || ts.isBindingPattern(root)) {
      if (ts.isBindingElement(root) && root.initializer) defaults.push(root.initializer);
      root = root.parent;
    }
    return { root, defaults };
  };
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
      if (ts.isTypeNode(part)) return;
      // Query parameters select rows; only projected values supply phrases.
      if (queryResult(part)) {
        queryWording(part).parts.forEach(inspect);
        return;
      }
      if (ts.isIdentifier(part))
        for (const declaration of declarations(part)) {
          const index = parameters.findIndex((parameter) => parameter === declaration);
          if (index >= 0) indices.add(index);
          if (ts.isVariableDeclaration(declaration) && declaration.initializer)
            inspect(declaration.initializer);
          if (ts.isVariableDeclaration(declaration))
            (symbol(declaration.name)
              ? (mutations.get(symbol(declaration.name)!) ?? [])
              : []
            ).forEach(inspect);
        }
      ts.forEachChild(part, inspect);
    };
    parts.forEach(inspect);
    if (indices.size) wrappers.set(owner, indices);
    return indices.size !== size;
  };
  for (const [node, kind] of direct) {
    if (!ts.isCallExpression(node)) {
      forward(node, writes.get(node)?.parts ?? phraseParts(node));
      continue;
    }
    const call = node;
    const args = invocationArguments(call);
    const parts =
      kind === 'restateSystemLine'
        ? args[2]
          ? phraseParts(args[2])
          : []
        : kind === 'systemLine'
          ? args[1]
            ? phraseParts(args[1])
            : []
          : (writes.get(node)?.parts ?? []);
    forward(node, parts);
  }
  // commander.ts skips human recipients with agentOnly and suppresses transcript
  // records with automatic. Both are required: agentOnly alone can still render
  // a report record. Unknown values, spreads, and non-identifier keys stay locked.
  const privateReport = (call: ts.CallExpression): boolean => {
    if (
      !named(call, 'reportToCommander') ||
      !callableDeclarations(call.expression).some(
        (declaration) =>
          ts.isFunctionDeclaration(declaration) &&
          declaration.name?.text === 'reportToCommander' &&
          declaration.getSourceFile().fileName === resolve(server, 'src/commander.ts'),
      )
    )
      return false;
    const args = invocationArguments(call);
    // Invocation adapters and argument spreads can obscure the options position.
    if (
      args.length !== call.arguments.length ||
      args.some(
        (argument, index) => argument !== call.arguments[index] || ts.isSpreadElement(argument),
      )
    )
      return false;
    const options = args[6];
    if (!options || !ts.isObjectLiteralExpression(options)) return false;
    if (
      options.properties.some(
        (property) => !ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name),
      )
    )
      return false;
    return ['automatic', 'agentOnly'].every((name) => {
      const properties = options.properties.filter((property) => property.name?.getText() === name);
      return (
        properties.length === 1 &&
        ts.isPropertyAssignment(properties[0]!) &&
        properties[0]!.initializer.kind === ts.SyntaxKind.TrueKeyword
      );
    });
  };
  // A conversation write can also carry cards, but an explicit ordinary-message
  // call cannot introduce System wording through its text/receipt parameters.
  const ordinaryReply = (call: ts.CallExpression) =>
    (call.arguments[0] && ts.isStringLiteralLike(call.arguments[0]) &&
      /^(sendRoomMessage|sendRoomReply)$/.test(call.arguments[0].text) &&
      callableDeclarations(call.expression).some((declaration) =>
        ts.isMethodDeclaration(declaration) && declaration.name.getText() === 'execute' &&
        declaration.getSourceFile().fileName === resolve(server, 'src/phone-service.ts'))) ||
    (callableDeclarations(call.expression).some((declaration) =>
      ts.isMethodDeclaration(declaration) && declaration.name.getText() === 'postRoomMessage' &&
      declaration.getSourceFile().fileName === resolve(server, 'src/daemon-service.ts')) &&
    call.arguments[0] && ts.isObjectLiteralExpression(call.arguments[0]) &&
    call.arguments[0].properties.some((property) => ts.isPropertyAssignment(property) &&
      property.name.getText() === 'presentation' && ts.isStringLiteralLike(property.initializer) &&
      property.initializer.text === 'message') &&
    !call.arguments[0].properties.some(ts.isSpreadAssignment));
  let changed = true;
  while (changed) {
    changed = false;
    for (const call of calls) {
      if (privateReport(call) || ordinaryReply(call)) continue;
      const indices = new Set(
        callableDeclarations(call.expression).flatMap((declaration) => [
          ...(wrappers.get(functions.get(declaration) ?? declaration) ?? []),
        ]),
      );
      if (!indices.size) continue;
      const args = invocationArguments(call);
      if (!direct.has(call)) direct.set(call, 'wrapper');
      if (
        forward(
          call,
          [...indices].flatMap((index) => (args[index] ? [args[index]!] : [])),
        )
      )
        changed = true;
    }
  }

  const entries = new Map<string, Entry>();
  // Parameters can carry local phrase arrays through several forwarding helpers.
  // Resolve actual callers rather than treating every typed array as opaque data.
  const parameterInputs = new Map<ts.ParameterDeclaration, ts.Node[]>();
  for (const call of calls) {
    const args = invocationArguments(call);
    for (const target of callableDeclarations(call.expression)) {
      const declaration = functions.get(target) ?? target;
      if (!ts.isFunctionLike(declaration)) continue;
      declaration.parameters.forEach((parameter, index) => {
        const inputs = parameter.dotDotDotToken ? args.slice(index) : args.slice(index, index + 1);
        parameterInputs.set(parameter, [...(parameterInputs.get(parameter) ?? []), ...inputs]);
      });
    }
  }
  // Follow phrase arrays through aliases, spreads and helper returns. A return
  // annotation alone cannot turn locally supplied wording into opaque data.
  const literalArray = (node: ts.Node, seen = new Set<ts.Node>()): boolean => {
    if (seen.has(node)) return false;
    seen.add(node);
    if (ts.isArrayLiteralExpression(node))
      return node.elements.some((element) => !ts.isSpreadElement(element) || literalArray(element.expression, seen));
    if (ts.isCallExpression(node)) {
      for (const declaration of callableDeclarations(node.expression)) {
        if (!ts.isFunctionLike(declaration) || !('body' in declaration) || !declaration.body) continue;
        let found = false;
        const returned = (part: ts.Node) => {
          if (ts.isReturnStatement(part) && part.expression) found ||= literalArray(part.expression, seen);
          else if (!ts.isFunctionLike(part)) ts.forEachChild(part, returned);
        };
        if (ts.isBlock(declaration.body)) ts.forEachChild(declaration.body, returned);
        else found = literalArray(declaration.body, seen);
        if (found) return true;
      }
      // Request arguments select external data; they are not returned arrays.
      // Chained array operations still retain the origin of their receiver.
      return ts.isPropertyAccessExpression(node.expression) && literalArray(node.expression.expression, seen);
    }
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      for (const declaration of declarations(node)) {
        // A destructured projection is not proven opaque by its container's
        // type. Retain wording dependencies even when its key/origin is unknown.
        // This covers object/array, renamed, nested, default and rest bindings.
        if (ts.isBindingElement(declaration)) return true;
        if (ts.isParameter(declaration) &&
          [...(parameterInputs.get(declaration) ?? []), ...(declaration.initializer ? [declaration.initializer] : [])]
            .some((input) => literalArray(input, seen))) return true;
        if ((ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration)) &&
          declaration.initializer && literalArray(declaration.initializer, seen)) return true;
        if (ts.isVariableDeclaration(declaration) && symbol(declaration.name) &&
          (mutations.get(symbol(declaration.name)!) ?? []).some((value) => literalArray(value, seen))) return true;
      }
    }
    return !!ts.forEachChild(node, (part) => literalArray(part, seen) || undefined);
  };
  const arrayData = (node: ts.Node, seen = new Set<ts.Node>()): boolean => {
    if (seen.has(node)) return false;
    seen.add(node);
    if (ts.isArrayLiteralExpression(node) || checker.isArrayType(checker.getTypeAtLocation(node))) return true;
    if (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node)) return arrayData(node.expression, seen);
    if (ts.isCallExpression(node))
      return callableDeclarations(node.expression).some((declaration) => {
        if (!ts.isFunctionLike(declaration) || !declaration.type) return false;
        const type = declaration.type;
        const arrayType = (type: ts.TypeNode): boolean => ts.isArrayTypeNode(type) ||
          ts.isTypeOperatorNode(type) && type.operator === ts.SyntaxKind.ReadonlyKeyword && arrayType(type.type);
        return arrayType(type) || ts.isTypeReferenceNode(type) &&
          type.typeName.getText() === 'Promise' && !!type.typeArguments?.some(arrayType);
      });
    return declarations(node).some((declaration) => {
      if (!ts.isVariableDeclaration(declaration)) return false;
      const values = [...(declaration.initializer ? [declaration.initializer] : []),
        ...(symbol(declaration.name) ? mutations.get(symbol(declaration.name)!) ?? [] : [])];
      return values.length > 0 && values.every((value) => arrayData(value, new Set(seen)));
    });
  };
  // A local helper that only builds the phrase is the message text, not another
  // producer. Inlining it keeps a move or rename on the same wording fingerprint.
  type PhraseFunction = ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression;
  const isPhraseFunction = (fn: ts.Node): fn is PhraseFunction =>
    (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn) || ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
    !!fn.body;
  const returnExpressions = (fn: PhraseFunction): ts.Expression[] => {
    if (!ts.isBlock(fn.body!)) return [fn.body as ts.Expression];
    const found: ts.Expression[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isReturnStatement(node)) {
        if (node.expression) found.push(node.expression);
      } else if (!ts.isFunctionLike(node)) ts.forEachChild(node, visit);
    };
    ts.forEachChild(fn.body!, visit);
    return found;
  };
  const sinkCalls = new Map<ts.Node, boolean>();
  const callsSink = (fn: PhraseFunction): boolean => {
    const cached = sinkCalls.get(fn);
    if (cached !== undefined) return cached;
    let found = false;
    const visit = (node: ts.Node) => {
      if (found || (node !== fn && ts.isFunctionLike(node))) return;
      if (ts.isCallExpression(node) && (named(node, 'systemLine') || named(node, 'restateSystemLine') || writes.has(node)))
        found = true;
      else ts.forEachChild(node, visit);
    };
    visit(fn);
    sinkCalls.set(fn, found);
    return found;
  };
  // Only straight phrase helpers. Inlining arbitrary functions rewalks the program.
  const simplePhraseBody = (fn: PhraseFunction) => {
    if (!fn.body) return false;
    if (!ts.isBlock(fn.body)) return true;
    return fn.body.statements.some((statement) => ts.isReturnStatement(statement)) &&
      fn.body.statements.every((statement) => ts.isReturnStatement(statement) || ts.isVariableStatement(statement));
  };
  // A helper may call another local helper. Follow that chain to the literal,
  // but only when every step just hands the phrase on. Stop at a fixed depth
  // so nested calls cannot rewalk the program. Builders that do more than
  // forward, such as composeSystemLine, stay on the old walk.
  const PHRASE_HELPER_CHAIN_LIMIT = 8;
  const PHRASE_CHAIN_TRUNCATED = -1;
  const straightPhrase = (fn: PhraseFunction) =>
    simplePhraseBody(fn) &&
    !callsSink(fn) &&
    fn.parameters.every((parameter) => !parameter.dotDotDotToken && ts.isIdentifier(parameter.name));
  const phraseCalleeCache = new Map<ts.Node, PhraseFunction[]>();
  const localPhraseCallees = (fn: PhraseFunction): PhraseFunction[] => {
    const cached = phraseCalleeCache.get(fn);
    if (cached) return cached;
    const found: PhraseFunction[] = [];
    const visit = (node: ts.Node) => {
      if (node !== fn && ts.isFunctionLike(node)) return;
      if (ts.isCallExpression(node)) {
        const seen = new Set<ts.Node>();
        for (const declaration of callableDeclarations(node.expression)) {
          const target = functions.get(declaration) ?? declaration;
          if (target === fn || seen.has(target) || !isPhraseFunction(target)) continue;
          seen.add(target);
          found.push(target);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(fn);
    phraseCalleeCache.set(fn, found);
    return found;
  };
  const pureForward = (node: ts.Node): boolean => {
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isAwaitExpression(node)
    )
      return pureForward(node.expression);
    if (
      ts.isStringLiteralLike(node) ||
      ts.isNumericLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      node.kind === ts.SyntaxKind.TrueKeyword ||
      node.kind === ts.SyntaxKind.FalseKeyword ||
      node.kind === ts.SyntaxKind.NullKeyword ||
      ts.isIdentifier(node)
    )
      return true;
    if (ts.isTemplateExpression(node))
      return node.templateSpans.every((span) => pureForward(span.expression));
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
      return pureForward(node.left) && pureForward(node.right);
    if (!ts.isCallExpression(node) || node.arguments.some((argument) => ts.isSpreadElement(argument)))
      return false;
    const targets = new Set<ts.Node>();
    for (const declaration of callableDeclarations(node.expression)) {
      const target = functions.get(declaration) ?? declaration;
      if (isPhraseFunction(target)) targets.add(target);
    }
    return targets.size === 1 && node.arguments.every((argument) => pureForward(argument));
  };
  const forwardingPhrase = (fn: PhraseFunction): boolean => {
    if (!straightPhrase(fn) || !fn.body) return false;
    if (!ts.isBlock(fn.body)) return pureForward(fn.body);
    return fn.body.statements.every((statement) =>
      ts.isReturnStatement(statement)
        ? !statement.expression || pureForward(statement.expression)
        : ts.isVariableStatement(statement) &&
          statement.declarationList.declarations.every(
            (declaration) => !declaration.initializer || pureForward(declaration.initializer),
          ),
    );
  };
  const phraseChainDepths = new Map<ts.Node, number | undefined>();
  const phraseChainVisiting = new Set<ts.Node>();
  // Undefined means a cycle or a callee that is not itself a straight phrase helper.
  // Truncation means the walk stopped at the depth limit and must not be cached:
  // the same helper can still be short when reached from a shallower call.
  const phraseChainDepth = (fn: PhraseFunction): number | undefined | typeof PHRASE_CHAIN_TRUNCATED => {
    if (phraseChainVisiting.has(fn)) return undefined;
    if (phraseChainDepths.has(fn)) return phraseChainDepths.get(fn);
    if (phraseChainVisiting.size >= PHRASE_HELPER_CHAIN_LIMIT) return PHRASE_CHAIN_TRUNCATED;
    phraseChainVisiting.add(fn);
    let depth = 1;
    let failed = false;
    let truncated = false;
    for (const callee of localPhraseCallees(fn)) {
      if (!straightPhrase(callee)) {
        failed = true;
        break;
      }
      const nestedCallees = localPhraseCallees(callee);
      if (nestedCallees.length > 0 && !forwardingPhrase(callee)) {
        failed = true;
        break;
      }
      const nested = phraseChainDepth(callee);
      if (nested === undefined) {
        failed = true;
        break;
      }
      if (nested === PHRASE_CHAIN_TRUNCATED) {
        truncated = true;
        break;
      }
      depth = Math.max(depth, 1 + nested);
    }
    phraseChainVisiting.delete(fn);
    if (truncated) return PHRASE_CHAIN_TRUNCATED;
    const result = failed || depth > PHRASE_HELPER_CHAIN_LIMIT ? undefined : depth;
    phraseChainDepths.set(fn, result);
    return result;
  };
  const phraseBuilder = (call: ts.CallExpression): PhraseFunction | undefined => {
    if (call.arguments.some((argument) => ts.isSpreadElement(argument))) return undefined;
    const found: PhraseFunction[] = [];
    const seen = new Set<ts.Node>();
    for (const declaration of callableDeclarations(call.expression)) {
      const fn = functions.get(declaration) ?? declaration;
      if (seen.has(fn) || !isPhraseFunction(fn) || !straightPhrase(fn)) continue;
      seen.add(fn);
      if (localPhraseCallees(fn).length > 0) {
        if (!forwardingPhrase(fn)) continue;
        const depth = phraseChainDepth(fn);
        if (depth === undefined || depth === PHRASE_CHAIN_TRUNCATED || depth > PHRASE_HELPER_CHAIN_LIMIT)
          continue;
      }
      found.push(fn);
    }
    return found.length === 1 ? found[0] : undefined;
  };
  const inlinedPhraseFunctions = new Set<ts.Node>();
  const inlineStack = new Set<ts.Node>();
  // Parameter uses repeat one argument. Walk that argument once and reuse its wording.
  const wordingCache = new Map<ts.Node, string[]>();
  let substitutions = new Map<ts.Node, ts.Node>();
  let argumentScope = new Map<ts.Node, ts.Node>();
  const ancestorInlined = (node: ts.Node) => {
    for (let current: ts.Node | undefined = node; current; current = current.parent)
      if (inlinedPhraseFunctions.has(current)) return true;
    return false;
  };
  for (const [node, kind] of direct) {
    if (kind === 'system-card' && ancestorInlined(node)) continue;
    if (
      kind === 'wrapper' &&
      ts.isCallExpression(node) &&
      callableDeclarations(node.expression).some((declaration) =>
        inlinedPhraseFunctions.has(functions.get(declaration) ?? declaration),
      )
    )
      continue;
    substitutions = new Map();
    argumentScope = new Map();
    const file = relative(server, node.getSourceFile().fileName).replaceAll('\\', '/');
    const template = writes.get(node)?.template ?? templatePrint(node);
    const scope: string[] = [];
    for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent)
      if (
        (ts.isFunctionDeclaration(parent) ||
          ts.isMethodDeclaration(parent) ||
          ts.isClassDeclaration(parent)) &&
        parent.name
      )
        scope.unshift(parent.name.getText());
    const location = `${file}:${scope.join('.') || 'module'}:${kind}`;
    // Hash the complete ordered stream; keep the lock's phrase inventory compact below.
    const literals: string[] = [...(writes.get(node)?.literals ?? [])];
    // Guard only the active dependency path: a second use contributes words again.
    const active = new Set<ts.Node>();
    const collect = (part: ts.Node) => {
      if (active.has(part)) return;
      active.add(part);
      try {
        if (ts.isTypeNode(part)) return;
        // Provider responses are data. Authentication and request construction
        // do not supply the prose wrapped around those responses at the sink.
        if (ts.isCallExpression(part) && ts.isPropertyAccessExpression(part.expression) &&
          part.getSourceFile().fileName === resolve(server, 'src/github-operations.ts') &&
          part.expression.expression.getText() === 'this.app' &&
          /^(issuesRequest|readCommitCheckRollup)$/.test(part.expression.name.text)) {
          literals.push(`provider:${(part.expression as ts.PropertyAccessExpression).name.text}`);
          return;
        }
        if (ts.isParenthesizedExpression(part) || ts.isAsExpression(part) || ts.isTypeAssertionExpression(part)) {
          collect(part.expression);
          return;
        }
        // Selection of opaque row/provider data does not supply fixed words.
        // Literal arrays retain callbacks because selection changes their wording.
        if (ts.isCallExpression(part) && ts.isPropertyAccessExpression(part.expression) &&
          /^(find|filter|sort)$/.test(part.expression.name.text) &&
          arrayData(part.expression.expression) && !literalArray(part.expression.expression)) {
          literals.push(`.${part.expression.name.text}()`, `.${part.expression.name.text}`);
          collect(part.expression.expression);
          return;
        }
        // This server helper returns only the sign-in card's logo/domain metadata.
        // Its network lookup and provider metadata cannot supply displayed wording.
        if (ts.isCallExpression(part) && callableDeclarations(part.expression).some(
          (declaration) => ts.isMethodDeclaration(declaration) &&
            declaration.name.getText() === 'appCardMark' &&
            declaration.getSourceFile().fileName === resolve(server, 'src/daemon-service.ts') &&
            metadataOnly(declaration),
        )) return;
        if (ts.isObjectLiteralExpression(part)) {
          wordingParts(part).forEach(collect);
          return;
        }
        // The private command transport contributes its returned command values,
        // not unrelated wake-bookkeeping statements in its transaction callback.
        // Explicit mutations of returned locals are still followed below.
        let producer: ts.Node | undefined = part.parent;
        while (producer && !ts.isFunctionDeclaration(producer)) producer = producer.parent;
        if (
          (ts.isArrowFunction(part) || ts.isFunctionExpression(part)) &&
          producer &&
          ts.isFunctionDeclaration(producer) &&
          producer.name?.text === 'createAgentCommand' &&
          producer.getSourceFile().fileName === resolve(server, 'src/agent-command.ts')
        ) {
          if (!ts.isBlock(part.body)) collect(part.body);
          else {
            const returned = (statement: ts.Node) => {
              if (ts.isReturnStatement(statement) && statement.expression)
                collect(statement.expression);
              else if (!ts.isFunctionLike(statement)) ts.forEachChild(statement, returned);
            };
            ts.forEachChild(part.body, returned);
          }
          return;
        }
        // Returned SQL expressions may supply words; access clauses do not.
        if (queryResult(part)) {
          const selected = queryWording(part);
          selected.literals.forEach((literal) => literals.push(literal));
          selected.parts.forEach(collect);
          return;
        }
        // Member/callee identities choose what people see, even without fixed words.
        // Omit the root local name so person.name and recipient.name stay equivalent.
        // A local phrase builder is inlined, so the helper call itself is not wording.
        if (ts.isBinaryExpression(part))
          literals.push(`binary:${ts.tokenToString(part.operatorToken.kind)}`);
        if (ts.isPrefixUnaryExpression(part) || ts.isPostfixUnaryExpression(part))
          literals.push(`${ts.isPrefixUnaryExpression(part) ? 'prefix' : 'postfix'}:${ts.tokenToString(part.operator)}`);
        if (ts.isConditionalExpression(part)) literals.push('conditional:?:');
        if (ts.isNumericLiteral(part) || ts.isBigIntLiteral(part) || ts.isRegularExpressionLiteral(part))
          literals.push(`${ts.SyntaxKind[part.kind]}:${part.text}`);
        if (part.kind === ts.SyntaxKind.TrueKeyword || part.kind === ts.SyntaxKind.FalseKeyword || part.kind === ts.SyntaxKind.NullKeyword)
          literals.push(ts.SyntaxKind[part.kind]);
        const localCallable = (target: ts.Node) => callableDeclarations(target).some((declaration) =>
          (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration) ||
            ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration)) && !!declaration.body);
        if (ts.isCallExpression(part)) {
          const builder = phraseBuilder(part);
          // inlineStack is the cycle guard. The size check is the depth bound.
          if (builder && !inlineStack.has(builder) && inlineStack.size < PHRASE_HELPER_CHAIN_LIMIT) {
            const savedSubstitutions = substitutions;
            const savedArguments = argumentScope;
            const calleeMap = new Map<ts.Node, ts.Node>();
            builder.parameters.forEach((parameter, index) => {
              const argument = part.arguments[index];
              if (argument && !ts.isSpreadElement(argument)) calleeMap.set(parameter, argument);
              else if (parameter.initializer) calleeMap.set(parameter, parameter.initializer);
            });
            substitutions = calleeMap;
            argumentScope = savedSubstitutions;
            inlineStack.add(builder);
            inlinedPhraseFunctions.add(builder);
            try {
              for (const expression of returnExpressions(builder)) collect(expression);
            } finally {
              inlineStack.delete(builder);
              substitutions = savedSubstitutions;
              argumentScope = savedArguments;
            }
            return;
          }
          const callee = part.expression;
          if (localCallable(callee)) literals.push('$local()');
          else if (ts.isIdentifier(callee)) literals.push(`${callee.text}()`);
          else if (ts.isPropertyAccessExpression(callee)) literals.push(`.${callee.name.text}()`);
        }
        if (ts.isPropertyAccessExpression(part))
          literals.push(localCallable(part) ? '.$local' : `.${part.name.text}`);
        if (ts.isStringLiteralLike(part)) literals.push(JSON.stringify(part.text));
        if (ts.isTemplateExpression(part)) {
          literals.push(JSON.stringify([part.head.text, ...part.templateSpans.map((span) => span.literal.text)]));
        }
        if (
          (ts.isIdentifier(part) || ts.isPropertyAccessExpression(part)) &&
          !(ts.isPropertyAccessExpression(part.parent) && part.parent.name === part) &&
          !(ts.isPropertyAssignment(part.parent) && part.parent.name === part)
        ) {
          if (ts.isIdentifier(part)) {
            for (const declaration of declarations(part)) {
              const replacement = substitutions.get(declaration);
              if (!replacement) continue;
              const cached = wordingCache.get(replacement);
              if (cached) {
                for (const token of cached) literals.push(token);
                return;
              }
              if (active.has(replacement)) return;
              const savedSubstitutions = substitutions;
              const savedArguments = argumentScope;
              substitutions = savedArguments;
              argumentScope = savedArguments;
              const start = literals.length;
              try {
                collect(replacement);
              } finally {
                substitutions = savedSubstitutions;
                argumentScope = savedArguments;
              }
              wordingCache.set(replacement, literals.slice(start));
              return;
            }
          }
          for (const declaration of declarations(part)) {
            if (!files.has(declaration.getSourceFile().fileName)) continue;
            if (ts.isVariableDeclaration(declaration) && declaration.initializer)
              collect(declaration.initializer);
            if (ts.isVariableDeclaration(declaration))
              (symbol(declaration.name)
                ? (mutations.get(symbol(declaration.name)!) ?? [])
                : []
              ).forEach(collect);
            if (ts.isBindingElement(declaration)) {
              const { root, defaults } = bindingOrigin(declaration);
              defaults.forEach(collect);
              if ((ts.isVariableDeclaration(root) || ts.isParameter(root)) && root.initializer)
                collect(root.initializer);
            }
            if (ts.isPropertyAssignment(declaration)) collect(declaration.initializer);
            // Formatting helpers carry literal phrases in their bodies, including imported helpers.
            if (
              (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) &&
              declaration.body &&
              !wrappers.has(declaration)
            ) {
              const returned = (statement: ts.Node) => {
                if (ts.isReturnStatement(statement) && statement.expression)
                  collect(statement.expression);
                else if (!ts.isFunctionLike(statement)) ts.forEachChild(statement, returned);
              };
              ts.forEachChild(declaration.body, returned);
            }
          }
        }
        ts.forEachChild(part, collect);
      } finally {
        if (ts.isBinaryExpression(part) || ts.isPrefixUnaryExpression(part) ||
          ts.isPostfixUnaryExpression(part) || ts.isConditionalExpression(part))
          literals.push('end:expression');
        active.delete(part);
      }
    };
    const args = ts.isCallExpression(node) ? invocationArguments(node) : [];
    // The database argument is transport, not a phrase dependency.
    if (ts.isCallExpression(node) && kind === 'systemLine') {
      if (args[1]) phraseParts(args[1]).forEach(collect);
    } else if (ts.isCallExpression(node) && kind === 'restateSystemLine') {
      if (args[2]) phraseParts(args[2]).forEach(collect);
    } else if (writes.has(node)) writes.get(node)!.parts.forEach(collect);
    else if (kind === 'wrapper' && ts.isCallExpression(node)) {
      const indices = callableDeclarations(node.expression).flatMap((declaration) => [
        ...(wrappers.get(functions.get(declaration) ?? declaration) ?? []),
      ]);
      indices.forEach((index) => {
        if (args[index]) collect(args[index]!);
      });
    } else collect(node);
    const id = `${location}:${createHash('sha256').update(JSON.stringify(literals)).digest('hex').slice(0, 16)}`;
    const prior = entries.get(id);
    if (prior) prior.occurrences++;
    else
      entries.set(id, {
        id,
        file: `apps/server/${file}`,
        kind,
        template,
        literals: [...new Set(literals)].sort(),
        occurrences: 1,
      });
  }
  const result = [...entries.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  scannedSources.set(key, result);
  return result;
}

function compare(current: Entry[], locked: Entry[]): { violations: string[]; removed: string[] } {
  // Location is review context. Moving a producer cannot change its ordered
  // wording fingerprint or the number of producers with that fingerprint.
  const signature = (entry: Entry) => `${entry.kind}:${entry.id.split(':').at(-1)}`;
  const inventory = (entries: Entry[]) => {
    const result = new Map<string, number>();
    for (const entry of entries)
      result.set(signature(entry), (result.get(signature(entry)) ?? 0) + entry.occurrences);
    return result;
  };
  const baseline = inventory(locked);
  const live = inventory(current);
  const violations = current
    .filter((entry) => live.get(signature(entry)) !== baseline.get(signature(entry)))
    .map((entry) => `${entry.file}: ${entry.id}`);
  return {
    violations,
    removed: locked.filter((entry) => live.get(signature(entry)) !== baseline.get(signature(entry)))
      .map((entry) => entry.id),
  };
}

function enforce(current: Entry[], locked: Entry[]): void {
  const result = compare(current, locked);
  if (result.violations.length || result.removed.length)
    throw new Error(failure + '\n' + [...result.violations, ...result.removed].join('\n'));
}

it('freezes System message producers and literal templates against the owner-reviewed lock', () => {
  const current = scan(sources(resolve(server, 'src')));
  const parsed = ts.parseConfigFileTextToJson(
    lockPath,
    '{\"entries\":' + readFileSync(lockPath, 'utf8') + '}',
  );
  if (parsed.error)
    throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n'));
  const locked = parsed.config.entries as Entry[];
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

it('rejects removal of a System producer', () => {
  const files = fixture();
  files.set('/fixtures/producer.ts', '');
  const result = compare(scan(files), scan(fixture()));
  expect(result.violations).toEqual([]);
  expect(result.removed).toHaveLength(1);
  expect(() => enforce(scan(files), scan(fixture()))).toThrow(failure);
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
  "db.sql`INSERT INTO messages(author_id,text) VALUES(${SYSTEM_IDENTITY_ID},'new tagged post')`;",
  "db.query(`INSERT INTO public.messages(author_id,text) VALUES($1,$2)`, [SYSTEM_IDENTITY_ID,'new interpolated post']);",
])('rejects another producer syntax: %s', (statement) => {
  const baseline = fixture();
  const changed = fixture(`export function added(db: any) { ${statement} }`);
  expect(compare(scan(changed), scan(baseline)).violations.length).toBeGreaterThan(0);
});

// Use the real transport implementation: a missing import must not make the
// fixture pass by hiding the human report/card sinks from the scanner.
function reportFixture(statement: string) {
  return new Map([
    [
      resolve(server, 'src/commander.ts'),
      readFileSync(resolve(server, 'src/commander.ts'), 'utf8'),
    ],
    [
      resolve(server, 'src/system-line.ts'),
      'export function systemLine(db: unknown, input: unknown) {}',
    ],
    [
      resolve(server, 'src/report-fixture.ts'),
      `import { reportToCommander as report } from './commander.js';
      import { systemLine } from './system-line.js';
      ${statement}`,
    ],
  ]);
}

it('allows changed agent-only wake/handoff wrapper wording', () => {
  const source = `function handoff(db: any, text: string) {
    return report(db, room, author, text, undefined, 'id', {automatic: true, agentOnly: true});
  } handoff(db, 'hello');`;
  const base = reportFixture(source);
  expect(() =>
    enforce(scan(reportFixture(source.replace('hello', 'goodbye'))), scan(base)),
  ).not.toThrow();
});

it.each([
  '{}',
  '{agentOnly: true}',
  '{automatic: true}',
  '{automatic: true, agentOnly: flag}',
  '{automatic: true, agentOnly: true, ...options}',
  '{automatic: true, agentOnly: true, [key]: false}',
  '{automatic: true, agentOnly: true, agentOnly: false}',
  "{automatic: true, agentOnly: true, 'agentOnly': false}",
  "{automatic: true, agentOnly: true, 'automatic': false}",
])('locks reports with a possible human delivery path: %s', (options) => {
  const source = `report(db, room, author, 'hello', undefined, 'id', ${options});`;
  expect(() =>
    enforce(scan(reportFixture(source.replace('hello', 'goodbye'))), scan(reportFixture(source))),
  ).toThrow(failure);
});

it('keeps argument spreads fail-closed even when flags appear in the options position', () => {
  const source = `report(...unknownArgs, room, author, 'hello', undefined, 'id', {automatic: true, agentOnly: true});`;
  expect(() =>
    enforce(scan(reportFixture(source.replace('hello', 'goodbye'))), scan(reportFixture(source))),
  ).toThrow(failure);
});

it('locks a wrapper feeding both a private handoff and a visible System line', () => {
  const source = `function handoff(db: any, text: string) {
    report(db, room, author, text, undefined, 'id', {automatic: true, agentOnly: true});
    systemLine(db, {verb: text});
  } handoff(db, 'hello');`;
  expect(() =>
    enforce(scan(reportFixture(source.replace('hello', 'goodbye'))), scan(reportFixture(source))),
  ).toThrow(failure);
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

it.each([
  "db.query('INSERT INTO messages(author_id,text) VALUES($1,$2)', [humanId, 'hello']);",
  "db.query(\"UPDATE messages SET text=$2 WHERE id=$1 AND presentation='message'\", [id, 'hello']);",
  "db.query('UPDATE messages SET reactions=$2 WHERE id=$1', [id, '{}']);",
])('ignores ordinary message writes: %s', (statement) => {
  expect(() => enforce(scan(fixture(statement)), scan(fixture()))).not.toThrow();
});

it('ignores SQL predicates in a System write while freezing its assigned wording', () => {
  const base = fixture(
    "db.query(`INSERT INTO messages(author_id,text) SELECT $1,$2 FROM memberships WHERE removed_at IS NULL`, [SYSTEM_IDENTITY_ID, 'hello']);",
  );
  const mutate = (before: string, after: string) =>
    new Map([...base].map(([path, text]) => [path, text.replace(before, after)]));
  expect(() =>
    enforce(scan(mutate('removed_at IS NULL', 'identity_id=$3')), scan(base)),
  ).not.toThrow();
  expect(() => enforce(scan(mutate("'hello'", "'goodbye'")), scan(base))).toThrow(failure);
});

it('ignores membership SQL reached through a phrase helper but freezes its returned wording', () => {
  const base = fixture(`async function member(db: any) {
    const row = await db.query('SELECT name FROM memberships WHERE removed_at IS NULL');
    return { name: row.name, verb: 'joined' };
  }
  line(db, { subject: await member(db), verb: 'arrived' });`);
  const mutate = (before: string, after: string) =>
    new Map([...base].map(([path, text]) => [path, text.replace(before, after)]));
  expect(() =>
    enforce(scan(mutate('removed_at IS NULL', 'identity_id=$1')), scan(base)),
  ).not.toThrow();
  expect(() => enforce(scan(mutate("verb: 'joined'", "verb: 'left'")), scan(base))).toThrow(
    failure,
  );
});

it('rejects a decreased producer count', () => {
  const once = fixture("line(db, { verb: 'hello' });");
  const twice = fixture("line(db, { verb: 'hello' }); line(db, { verb: 'hello' });");
  expect(() => enforce(scan(once), scan(twice))).toThrow(failure);
});

it.each([
  "db.query(\"INSERT INTO messages(text,presentation) VALUES('hello','system')\");",
  "db.query('INSERT INTO messages(text,presentation) VALUES($1,$2)', ['hello','system']);",
  "db.query('INSERT INTO messages(text,card_type) VALUES($1,$2)', ['hello','grant-request']);",
  "db.query('UPDATE messages SET presentation=$2 WHERE id=$1', [id,'system']);",
  "const author=SYSTEM_IDENTITY_ID; db.query('INSERT INTO messages(author_id,text) VALUES($1,$2)', [author,'hello']);",
])('rejects a direct System producer: %s', (statement) => {
  expect(() => enforce(scan(fixture(statement)), scan(fixture()))).toThrow(failure);
});

it.each([
  'const emit=line.bind(null,db); emit({verb:wording});',
  'const emit=line.bind(null); emit(db,{verb:wording});',
  'const emit=line.bind(null,db,{verb:wording}); emit();',
  'const emit=line.bind(null,db); const alias=emit; alias({verb:wording});',
  'const emit=line.bind(null).bind(null,db); emit({verb:wording});',
  'line.call(null,db,{verb:wording});',
  'line.apply(null,[db,{verb:wording}]);',
  'const args=[db,{verb:wording}]; line.apply(null,args);',
  'const emit=line.bind(null,db); emit.call(null,{verb:wording});',
  'const emit=line.bind(null,db); emit.apply(null,[{verb:wording}]);',
  'function note(db: unknown, phrase: unknown) { return line(db,phrase); } const emit=note.bind(null,db); emit({verb:wording});',
  'function note(db: unknown, phrase: unknown) { return line(db,phrase); } note.call(null,db,{verb:wording});',
  'function note(db: unknown, phrase: unknown) { return line(db,phrase); } note.apply(null,[db,{verb:wording}]);',
])('freezes wording dependencies through invocation adapters: %s', (statement) => {
  const base = fixture("const wording='hello';" + statement);
  const changed = new Map(base);
  changed.set(
    '/fixtures/producer.ts',
    base.get('/fixtures/producer.ts')!.replace("wording='hello'", "wording='goodbye'"),
  );
  expect(() => enforce(scan(changed), scan(base))).toThrow(failure);
});

it.each([
  'const emit=line.bind(null,db,id); emit({verb:wording});',
  'line.call(null,db,id,{verb:wording});',
  'const args=[db,id,{verb:wording}]; line.apply(null,args);',
])('freezes restated wording through invocation adapters: %s', (statement) => {
  const base = fixture("const wording='hello';" + statement);
  base.set(
    '/fixtures/system-line.ts',
    'export function restateSystemLine(db: unknown, id: unknown, input: unknown) {}',
  );
  base.set(
    '/fixtures/producer.ts',
    base.get('/fixtures/producer.ts')!.replace('systemLine as line', 'restateSystemLine as line'),
  );
  const changed = new Map(base);
  changed.set(
    '/fixtures/producer.ts',
    base.get('/fixtures/producer.ts')!.replace("wording='hello'", "wording='goodbye'"),
  );
  expect(() => enforce(scan(changed), scan(base))).toThrow(failure);
});

it('follows aliases of forwarding wrappers', () => {
  const base = fixture(
    'function note(db: unknown, phrase: unknown) { return line(db, phrase); } const alias = note;',
  );
  const changed = new Map(base);
  changed.set(
    '/fixtures/producer.ts',
    base.get('/fixtures/producer.ts')! + "alias(db, { verb: 'hello' });",
  );
  expect(() => enforce(scan(changed), scan(base))).toThrow(failure);
});

it('follows an external System identity import alias', () => {
  const base = fixture();
  const changed = new Map(base);
  changed.set(
    '/fixtures/producer.ts',
    base.get('/fixtures/producer.ts')! +
      `
    import { SYSTEM_IDENTITY_ID as author } from '@beeline/api-contract/system-identity';
    db.query('INSERT INTO messages(author_id,text) VALUES($1,$2)', [author,'hello']);`,
  );
  expect(() => enforce(scan(changed), scan(base))).toThrow(failure);
});

it('finds a System write to an interpolated table', () => {
  expect(() =>
    enforce(
      scan(
        fixture(
          "const table='messages'; db.query(`INSERT INTO public.${table}(author_id,text) VALUES($1,$2)`, [SYSTEM_IDENTITY_ID,'hello']);",
        ),
      ),
      scan(fixture()),
    ),
  ).toThrow(failure);
});

it('allows access predicate changes in sendMessage, deleteRoomMessage and recordAnswer', () => {
  const base = sources(resolve(server, 'src'));
  const changed = new Map(base);
  for (const [filename, methods] of [
    ['phone-service.ts', ['sendMessage', 'deleteRoomMessage']],
    ['voice-service.ts', ['recordAnswer']],
  ] as const) {
    const path = resolve(server, 'src', filename);
    let text = changed.get(path)!;
    for (const method of methods) {
      const ast = parsedSource(path, text);
      let found = false;
      const visit = (node: ts.Node) => {
        if (ts.isMethodDeclaration(node) && node.name.getText(ast) === method) {
          const before = node.getText(ast);
          const after = before.replaceAll(
            'removed_at IS NULL',
            'removed_at IS NOT DISTINCT FROM NULL',
          );
          expect(after).not.toBe(before);
          text = text.slice(0, node.getStart(ast)) + after + text.slice(node.end);
          found = true;
        } else ts.forEachChild(node, visit);
      };
      visit(ast);
      expect(found).toBe(true);
    }
    changed.set(path, text);
  }
  expect(() => enforce(scan(changed), scan(base))).not.toThrow();
}, 30_000);

it('freezes every row of a multi-row System insert', () => {
  const base = fixture(
    "db.query(\"INSERT INTO messages(text,presentation) VALUES('one','system'),('two','system')\");",
  );
  const changed = new Map(
    [...base].map(([path, text]) => [path, text.replace("'two'", "'three'")]),
  );
  expect(() => enforce(scan(changed), scan(base))).toThrow(failure);
});

it('ignores no-op locks on message cards', () => {
  expect(() =>
    enforce(
      scan(fixture("db.query('UPDATE messages SET card=card WHERE id=$1', [id]);")),
      scan(fixture()),
    ),
  ).not.toThrow();
});

it('ignores a nested query predicate in a System card update', () => {
  const base = fixture(
    "db.query(`UPDATE messages SET card=jsonb_build_object('name',(SELECT name FROM memberships WHERE removed_at IS NULL)) WHERE id=$1`, [id]);",
  );
  const changed = new Map(
    [...base].map(([path, text]) => [path, text.replace('removed_at IS NULL', 'identity_id=$2')]),
  );
  expect(() => enforce(scan(changed), scan(base))).not.toThrow();
});

it.each([
  "function words() { let text='hello'; text += ' world'; return text; }",
  "function words() { const text=['hello']; text.push(' world'); return text.join(''); }",
])('freezes wording assembled by a formatting helper: %s', (helper) => {
  const base = fixture(helper + 'line(db, {verb: words()});');
  const changed = new Map(
    [...base].map(([path, text]) => [path, text.replace(' world', ' everyone')]),
  );
  expect(() => enforce(scan(changed), scan(base))).toThrow(failure);
});

it('ignores an access query embedded in a System phrase input', () => {
  const base = fixture(
    "line(db, {subject: await db.query('SELECT name FROM memberships WHERE removed_at IS NULL'), verb: 'joined'});",
  );
  const changed = new Map(
    [...base].map(([path, text]) => [path, text.replace('removed_at IS NULL', 'identity_id=$1')]),
  );
  expect(() => enforce(scan(changed), scan(base))).not.toThrow();
});

it('follows an aliased System presentation in a direct card', () => {
  expect(() =>
    enforce(
      scan(fixture("const presentation='system'; db.send({presentation, text:'hello'});")),
      scan(fixture()),
    ),
  ).toThrow(failure);
});

it.each([
  `async function words(db: any) { const result = await db.query("SELECT 'hello' AS phrase"); return result.rows[0].phrase; }`,
  `async function words(db: any) { const result = await db.query("SELECT 'hello' AS phrase FROM memberships WHERE role='member'"); return result.rows[0].phrase; }`,
  `async function words(db: any) { const result = await db.query('SELECT $1 AS phrase FROM memberships WHERE role=$2', ['hello','member']); return result.rows[0].phrase; }`,
  "async function words(db: any) { const result = await db.sql`SELECT ${'hello'} AS phrase FROM memberships WHERE role=${'member'}`; return result[0].phrase; }",
])('freezes SQL wording returned through a helper: %s', (helper) => {
  const base = fixture(helper + 'line(db, {verb: await words(db)});');
  const mutate = (before: string, after: string) =>
    new Map([...base].map(([path, text]) => [path, text.replace(before, after)]));
  expect(() => enforce(scan(mutate('hello', 'goodbye')), scan(base))).toThrow(failure);
  expect(() => enforce(scan(mutate("member'", "owner'")), scan(base))).not.toThrow();
});

it('keeps SQL fragment helpers inside query expression analysis', () => {
  const base = fixture(
    "function members() { return `ARRAY(SELECT name FROM memberships WHERE role='member')`; } async function words(db: any) { const result=await db.query(`SELECT ${members()} AS phrase`); return result.rows[0].phrase; } line(db,{verb:await words(db)});",
  );
  const changed = new Map(
    [...base].map(([path, text]) => [path, text.replace("role='member'", "role='owner'")]),
  );
  expect(() => enforce(scan(changed), scan(base))).not.toThrow();
});

it('freezes SQL CASE output words without freezing its predicate', () => {
  const base = fixture(
    `async function words(db: any) { const result=await db.query("SELECT CASE WHEN role='member' THEN 'hello' ELSE name END AS phrase FROM memberships"); return result.rows[0].phrase; } line(db,{verb:await words(db)});`,
  );
  const mutate = (before: string, after: string) =>
    new Map([...base].map(([path, text]) => [path, text.replace(before, after)]));
  expect(() => enforce(scan(mutate('hello', 'goodbye')), scan(base))).toThrow(failure);
  expect(() => enforce(scan(mutate("role='member'", "role='owner'")), scan(base))).not.toThrow();
});

it.each([
  "SELECT json_build_object('body','hello') AS card FROM memberships WHERE role='member'",
  "SELECT 'hello' || name AS phrase FROM memberships WHERE role='member'",
  "VALUES ('hello')",
  'SELECT $$hello$$ AS phrase',
  'SELECT $word$hello$word$ AS phrase',
  "INSERT INTO scratch(text) VALUES ('hello') RETURNING text",
  "UPDATE scratch SET text='hello' WHERE role='member' RETURNING text",
  "INSERT INTO scratch DEFAULT VALUES RETURNING 'hello' AS phrase",
])('freezes returned SQL output wording: %s', (query) => {
  const base = fixture(
    `async function words(db: any) { const result=await db.query(${JSON.stringify(query)}); return result.rows[0]; } line(db,{verb:'said',cardType:'notice',card:await words(db)});`,
  );
  const changed = new Map(
    [...base].map(([path, text]) => [path, text.replace('hello', 'goodbye')]),
  );
  expect(() => enforce(scan(changed), scan(base))).toThrow(failure);
});

it.each([
  "SELECT EXISTS(SELECT 'member' FROM memberships WHERE role='member') AS allowed, 'hello' AS phrase",
  "SELECT 'hello' AS phrase FROM memberships WHERE role=(SELECT 'member')",
  "SELECT 'hello' AS phrase FROM memberships m JOIN rooms r ON r.kind=(SELECT 'member')",
  "SELECT 'hello' AS phrase, count(*) FILTER (WHERE role='member') AS count FROM memberships",
])('excludes SQL literals used only as access predicates: %s', (query) => {
  const base = fixture(
    `async function words(db: any) { const result=await db.query(${JSON.stringify(query)}); return result.rows[0].phrase; } line(db,{verb:await words(db)});`,
  );
  const changed = new Map(
    [...base].map(([path, text]) => [path, text.replaceAll("member'", "owner'")]),
  );
  expect(() => enforce(scan(changed), scan(base))).not.toThrow();
});

it('freezes direct SQL CASE output while excluding its access predicate', () => {
  const base = fixture(
    `db.query("INSERT INTO messages(author_id,text) SELECT $1,CASE WHEN role='member' THEN 'hello' ELSE name END FROM memberships",[SYSTEM_IDENTITY_ID]);`,
  );
  const mutate = (before: string, after: string) =>
    new Map([...base].map(([path, text]) => [path, text.replace(before, after)]));
  expect(() => enforce(scan(mutate('hello', 'goodbye')), scan(base))).toThrow(failure);
  expect(() => enforce(scan(mutate("role='member'", "role='owner'")), scan(base))).not.toThrow();
});

it('freezes direct System wording in an upsert SET outcome', () => {
  const base = fixture(
    `db.query("INSERT INTO messages(author_id,text) VALUES($1,'old') ON CONFLICT(id) DO UPDATE SET text='hello' WHERE messages.text='member'",[SYSTEM_IDENTITY_ID]);`,
  );
  const mutate = (before: string, after: string) =>
    new Map([...base].map(([path, text]) => [path, text.replace(before, after)]));
  expect(() => enforce(scan(mutate('hello', 'goodbye')), scan(base))).toThrow(failure);
  expect(() => enforce(scan(mutate("text='member'", "text='owner'")), scan(base))).not.toThrow();
});
it('SYSTEM-VISIBILITY-2: private wake bookkeeping does not change the five mixed wrapper snapshots', () => {
  const base = sources(resolve(server, 'src'));
  const baseline = scan(base);
  const scopes = [
    'sendOrder',
    'checksReported',
    'ensureReviewDispatch',
    'noteReviewBlocked',
    'reassignFailedCornerReviewer',
  ];
  for (const scope of scopes)
    expect(
      baseline.some((entry) => entry.kind === 'wrapper' && entry.id.includes(`:${scope}:`)),
    ).toBe(true);
  const changed = new Map(base);
  const path = resolve(server, 'src/agent-command.ts');
  const text = base.get(path)!;
  const before = '  if (command && reviewContext) {';
  expect(text.split(before)).toHaveLength(2);
  changed.set(
    path,
    text
      .replace(
        before,
        `  if (command && input.reason === 'corner_brief_revision') {
    await db.query("UPDATE agent_commands SET wake_context=jsonb_build_object('briefRevision',1) WHERE id=$1", [command.id]);
  }
${before}`,
      )
      .replace('Current handoff target: PR #', 'Private handoff target: PR #'),
  );
  const current = scan(changed);
  for (const scope of scopes) {
    const entries = (items: Entry[]) =>
      items.filter((entry) => entry.kind === 'wrapper' && entry.id.includes(`:${scope}:`));
    expect(entries(current)).toEqual(entries(baseline));
  }
  expect(() => enforce(current, baseline)).not.toThrow();
  console.info(
    'SYSTEM-VISIBILITY-2: all five real wrapper snapshots accept private wake bookkeeping and handoff-note changes',
  );
}, 30_000);

it.each([
  ['commander.ts', "'ordered'", "'public wording changed'"],
  ['corner-lifecycle.ts', "'requested review of'", "'public wording changed'"],
  ['agent-command.ts', "verb: 'requested another check of'", "verb: 'public wording changed'"],
])(
  'SYSTEM-VISIBILITY-2: visible wording in %s remains locked',
  (filename, before, after) => {
    const base = sources(resolve(server, 'src'));
    const path = resolve(server, 'src', filename);
    expect(base.get(path)).toContain(before);
    const changed = new Map(base);
    changed.set(path, base.get(path)!.replace(before, after));
    expect(() => enforce(scan(changed), scan(base))).toThrow(failure);
  },
  30_000,
);

it.each([
  "return 'visible callback words';",
  "let text='visible callback words'; text += ' changed'; return text;",
  "return (await db.query(\"SELECT 'visible callback words' AS text FROM agent_commands\")).rows[0].text;",
])('keeps returned command callback wording and mutations locked: %s', (body) => {
  const files = new Map([
    [
      resolve(server, 'src/agent-command.ts'),
      `export function createAgentCommand(db: any) { return db.transaction(async () => { ${body} }); }`,
    ],
    [
      resolve(server, 'src/system-line.ts'),
      'export function systemLine(db: unknown, input: unknown) {}',
    ],
    [
      resolve(server, 'src/callback-fixture.ts'),
      "import {createAgentCommand} from './agent-command.js'; import {systemLine} from './system-line.js'; systemLine(db,{verb:await createAgentCommand(db)});",
    ],
  ]);
  const changed = new Map(
    [...files].map(([path, text]) => [
      path,
      text.replace('visible callback words', 'unapproved callback words'),
    ]),
  );
  expect(() => enforce(scan(changed), scan(files))).toThrow(failure);
});

// Reproduction SYSTEM-WORDING-1 exercises the same scanner/enforcer used by CI.
it.each([
  ["'hello ' + 'world'", "'hello ' || 'world'"],
  ["'hello ' + 'world'", "'hello ' && 'world'"],
  ["'hello ' + 'world'", "'hello ' ?? 'world'"],
  ["('hello ' + 'world') || '!'", "'hello ' + ('world' || '!')"],
  ["(left + right) + '!'", "left + (right + '!')"],
  ["flag ? 'hello ' : 'world'", "!flag ? 'hello ' : 'world'"],
  ["true ? 'hello ' : 'world'", "false ? 'hello ' : 'world'"],
  ["0 ? 'hello ' : 'world'", "1 ? 'hello ' : 'world'"],
  ["'hello world'.replace(/world/, '!')", "'hello world'.replace(/hello/, '!')"],
])('SYSTEM-WORDING-1: rejects changed visible expression operators: %s → %s', (before, after) => {
  const base = fixture(`line(db,{verb:${before}});`);
  const changed = new Map([...base].map(([path, text]) => [path, text.replace(before, after)]));
  const baseline = scan(base);
  const current = scan(changed);
  expect(() => enforce(current, baseline)).toThrow(failure);
  expect(current.map((entry) => entry.id)).not.toEqual(baseline.map((entry) => entry.id));
});

it.each([
  ["'hello ' + 'world'", "'world' + 'hello '"],
  ["'hello ' + 'world'", "'hello ' + 'world' + 'world'"],
  ["word + 'world'", "word + word + 'world'"],
])('SYSTEM-WORDING-1: rejects reordered or repeated visible words: %s → %s', (before, after) => {
  const base = fixture(`const word='hello '; line(db,{verb:${before}});`);
  const changed = new Map([...base].map(([path, text]) => [path, text.replace(before, after)]));
  const baseline = scan(base);
  const current = scan(changed);
  expect(current.map((entry) => entry.id)).not.toEqual(baseline.map((entry) => entry.id));
  expect(() => enforce(current, baseline)).toThrow(failure);
});

it('SYSTEM-WORDING-1: accepts hidden sign-in card fields and code refactors', () => {
  const base = fixture("line(db,{verb:'requested sign-in',cardType:'app-sign-in',card:{name:'Gmail'}});");
  for (const replacement of [
    "name:'Gmail',domain:'gmail.com'",
    "name:'Gmail',domain:'google.com',appId:'internal-id'",
  ]) {
    const changed = new Map([...base].map(([path, text]) => [path, text.replace("name:'Gmail'", replacement)]));
    expect(() => enforce(scan(changed), scan(base))).not.toThrow();
  }
  const renamed = new Map([...base].map(([path, text]) => [path, text.replaceAll('phrase', 'wording').replaceAll('line(db,', 'line( db ,')]));
  expect(() => enforce(scan(renamed), scan(base))).not.toThrow();

  // The real server spreads this helper's result into the card after #2977.
  const helper = resolve(server, 'src/daemon-service.ts');
  const metadata = new Map([
    [resolve(server, 'src/system-line.ts'), 'export function systemLine(db: unknown, input: unknown) {}'],
    [helper, `import {systemLine} from './system-line.js';
      class Service {
        appCardMark() { const mark=()=>({logo:'https://app.test/logo',domain:'app.test'}); return mark(); }
        notice() { const mark=this.appCardMark(); systemLine(db,{verb:'sign in',card:{name:'App',...mark}}); }
      }`],
  ]);
  const baseline = scan(metadata);
  const changed = new Map(metadata);
  changed.set(helper, metadata.get(helper)!.replaceAll('app.test', 'other.test'));
  expect(() => enforce(scan(changed), baseline)).not.toThrow();
  changed.set(helper, metadata.get(helper)!.replace("domain:'app.test'", "domain:'app.test',custom:'visible words'"));
  expect(() => enforce(scan(changed), baseline)).toThrow(failure);
});

it.each(['Gmail', 'requested sign-in'])('SYSTEM-WORDING-1: rejects visible card wording changes: %s', (word) => {
  const base = fixture("line(db,{verb:'requested sign-in',cardType:'app-sign-in',card:{name:'Gmail'}});");
  const changed = new Map([...base].map(([path, text]) => [path, text.replace(word, 'Changed wording')]));
  expect(() => enforce(scan(changed), scan(base))).toThrow(failure);
});

// Unknown payload fields must stay locked until their rendering is understood.
it.each([
  "card:{custom:'visible words'}",
  "card:{nested:{custom:'visible words'}}",
  "card:{...{custom:'visible words'}}",
  "card:{['custom']:'visible words'}",
  "card:{'name':'visible words', 'domain':'gmail.com'}",
])('locks conservatively collected wording: %s', (payload) => {
  const base = fixture(`line(db,{verb:'requested sign-in',${payload}});`);
  const changed = new Map([...base].map(([path, text]) => [path, text.replace('visible words', 'changed words')]));
  expect(() => enforce(scan(changed), scan(base))).toThrow(failure);
});

it('accepts renamed template expressions while locking their visible fragments', () => {
  const base = fixture("const person=external; line(db,{verb:`hello ${person}!`});");
  const renamed = new Map([...base].map(([path, text]) => [path, text.replaceAll('person', 'recipient')]));
  expect(() => enforce(scan(renamed), scan(base))).not.toThrow();
  const changed = new Map([...base].map(([path, text]) => [path, text.replace('hello ${person}!', '!${person}hello ')]));
  expect(() => enforce(scan(changed), scan(base))).toThrow(failure);
});

it('SYSTEM-WORDING-1: the real app sign-in producer accepts domain metadata and rejects visible wording', () => {
  const base = sources(resolve(server, 'src'));
  const path = resolve(server, 'src/daemon-service.ts');
  const before = "card: { appId: firstParty.appId, appKey: firstParty.key, name: firstParty.name,";
  expect(base.get(path)!.split(before)).toHaveLength(2);
  const baseline = scan(base);
  const changed = new Map(base);
  changed.set(path, base.get(path)!.replace(before, before + " domain: 'stripe.com',"));
  expect(() => enforce(scan(changed), baseline)).not.toThrow();
  changed.set(path, changed.get(path)!.replace('Sign in to continue the request.', 'Sign in to finish the request.'));
  expect(() => enforce(scan(changed), baseline)).toThrow(failure);
  console.info('SYSTEM-WORDING-1: real app sign-in domain addition passes; visible wording change fails');
}, 60_000);

it.each([
  ['owner.name', 'owner.email'],
  ['fmt(x)', 'other(x)'],
  ['owner.profile.name', 'owner.profile.email'],
  ['owner.format(x)', 'owner.other(x)'],
])('locks the displayed expression identity: %s → %s', (before, after) => {
  const base = fixture(`export function notice(owner: any, fmt: any, other: any, x: any) {
    line(db,{verb:\`hello \${${before}}\`});
  }`);
  const changed = new Map([...base].map(([path, text]) => [path, text.replace(before, after)]));
  expect(() => enforce(scan(changed), scan(base))).toThrow(failure);
});

it('accepts local root renames for displayed member access and method calls', () => {
  const base = fixture(`export function notice(person: any) {
    line(db,{verb:\`hello \${person.name} \${person.format()}\`});
  }`);
  const renamed = new Map([...base].map(([path, text]) => [path, text.replaceAll('person', 'recipient')]));
  expect(() => enforce(scan(renamed), scan(base))).not.toThrow();
});

// Reproduction freeze: command depth and receipt routing are not displayed.
it.each([
  ["causeId:'old-receipt'", "causeId:'new-receipt'"],
  ["wakes:['old-agent']", "wakes:['new-agent']"],
  ["payload:{entry:'automatic'}", "payload:{entry:'manual'}"],
])('freeze: accepts System transport metadata changes: %s', (before, after) => {
  const base = fixture(`line(db,{verb:'joined',${before}});`);
  const changed = new Map([...base].map(([path,text]) => [path,text.replace(before,after)]));
  expect(() => enforce(scan(changed),scan(base))).not.toThrow();
  const visible = new Map([...changed].map(([path,text]) => [path,text.replaceAll("verb:'joined'", "verb:'left'")]));
  expect(() => enforce(scan(visible),scan(base))).toThrow(failure);
});

it('freeze: accepts real shared command depth metadata', () => {
  const base=sources(resolve(server,'src'));
  const path=resolve(server,'src/agent-command.ts');
  const before='? parent.agent_depth : nextAgentDepth(parent.agent_depth) : 0';
  expect(base.get(path)).toContain(before);
  const changed=new Map(base);
  changed.set(path,base.get(path)!.replace(before,'? parent.agent_depth : nextAgentDepth(parent.agent_depth) : input.initialAgentDepth ?? 0'));
  expect(() => enforce(scan(changed),scan(base))).not.toThrow();
},60_000);


// Reproduction SYSTEM-REFACTOR-2: reduced replays of the four actual failed CI heads.
const refactors = JSON.parse(readFileSync(resolve(server, 'test-fixtures/system-wording-refactors.json'), 'utf8')) as {
  pr: number; run: string; head: string; file: string; mode: string; name?: string; before: string; after: string;
}[];
it.each(refactors)('SYSTEM-REFACTOR-2: PR $pr / run $run preserves visible wording', (refactor) => {
  const base = sources(resolve(server, 'src'));
  const path = resolve(server, '../..', refactor.file);
  const source = base.get(path)!;
  const replay = (version: string) => {
    const files = new Map(base);
    if (refactor.mode === 'file') files.set(path, version);
    else if (refactor.mode === 'replace') {
      expect(source).toContain(refactor.before);
      files.set(path, source.replace(refactor.before, version));
    } else {
      const tree = parsedSource(path, source);
      let target: ts.MethodDeclaration | undefined;
      const visit = (node: ts.Node) => {
        if (ts.isMethodDeclaration(node) && node.name.getText(tree) === (refactor.name ?? 'execute')) target = node;
        ts.forEachChild(node, visit);
      };
      visit(tree);
      expect(target).toBeDefined();
      if (refactor.mode === 'method')
        files.set(path, source.slice(0,target!.getStart(tree)) + version + source.slice(target!.end));
      else {
        const position = target!.body!.getStart(tree) + 1;
        files.set(path, source.slice(0,position) + '\n' + version + '\n' + source.slice(position));
      }
    }
    return files;
  };
  const before = scan(replay(refactor.before));
  const after = scan(replay(refactor.after));
  const result = compare(after, before);
  console.info('SYSTEM-REFACTOR-2', refactor.pr, JSON.stringify(result));
  expect(() => enforce(after,before)).not.toThrow();
},60_000);

it('SYSTEM-REFACTOR-2: moves strings and producers, renames locals, and reformats without changing words', () => {
  const base = fixture("const greeting='hello'; function formatName(person:any) { return person.name; } line(db,{verb:`${greeting} ${formatName(owner)}`});");
  const moved = new Map([...base].map(([path,text]) => [path.endsWith('producer.ts') ? path.replace('producer.ts','moved.ts') : path,
    text.replaceAll('existing','renamedProducer').replaceAll('greeting','salutation').replaceAll('formatName','renderName').replaceAll('person','recipient').replaceAll('line(db,','line( db ,')]));
  expect(() => enforce(scan(moved),scan(base))).not.toThrow();
  const changed = new Map([...moved].map(([path,text])=>[path,text.replace("'hello'","'goodbye'")]));
  expect(() => enforce(scan(changed),scan(base))).toThrow(failure);
});

it('R1: moving a guarded message into another function or file with the same text passes', () => {
  const base = fixture("line(db, { verb: 'hello there' });");
  const moved = fixture(`
    function buildNotice() { return { verb: 'hello there' }; }
    line(db, buildNotice());
  `);
  expect(() => enforce(scan(moved), scan(base))).not.toThrow();
  const renamed = fixture(`
    function renderNotice(name: string) { return { verb: 'hello ' + name }; }
    line(db, renderNotice('there'));
  `);
  const inPlace = fixture("line(db, { verb: 'hello ' + 'there' });");
  expect(() => enforce(scan(renamed), scan(inPlace))).not.toThrow();
  const otherFile = fixture();
  otherFile.set('/fixtures/builder.ts', "export function buildNotice() { return { verb: 'hello there' }; }");
  otherFile.set(
    '/fixtures/producer.ts',
    `import { systemLine as line } from './system-line.js';
     import { buildNotice } from './builder.js';
     const phrase = 'joined';
     export function existing(db: unknown) { return line(db, { verb: phrase }); }
     line(db, buildNotice());`,
  );
  expect(() => enforce(scan(otherFile), scan(base))).not.toThrow();
  const addedCall = fixture(`
    function identity(text: string) { return text; }
    line(db, { verb: identity('hello there') });
  `);
  expect(() => enforce(scan(addedCall), scan(base))).not.toThrow();
  const changed = fixture("line(db, { verb: 'hello world' });");
  expect(() => enforce(scan(changed), scan(base))).toThrow(failure);
});

it('R1: a chain of local helpers that only returns the voice-call verb keeps the same wording', () => {
  const base = sources(resolve(server, 'src'));
  const path = resolve(server, 'src/voice-service.ts');
  const source = base.get(path)!;
  const before = "verb: 'started'";
  expect(source.match(/verb: 'started'/g)).toEqual([before]);
  const moved = new Map(base);
  moved.set(path, `${source.replace(before, 'verb: voiceStart()')}
    function voiceIdentity(text: string) { return text; }
    function voiceStart() { return voiceIdentity('started'); }
  `);
  expect(() => enforce(scan(moved), scan(base))).not.toThrow();
  const reworded = new Map(base);
  reworded.set(path, moved.get(path)!.replace("voiceIdentity('started')", "voiceIdentity('stopped')"));
  expect(() => enforce(scan(reworded), scan(base))).toThrow(failure);
}, 60_000);

it('SYSTEM-REFACTOR-2: keeps SQL projected parameters locked across forwarding helpers', () => {
  const base=fixture("function notice(word:string) { line(db,{verb:db.query('SELECT $1 AS phrase',[word]).rows[0].phrase}); } notice('hello');");
  const changed=new Map([...base].map(([path,text])=>[path,text.replace("notice('hello')","notice('goodbye')")]));
  expect(() => enforce(scan(changed),scan(base))).toThrow(failure);
});

it('SYSTEM-REFACTOR-2: excludes explicit conversation replies while retaining card wording', () => {
  const path = resolve(server, 'src/daemon-service.ts');
  const files = new Map([
    [resolve(server,'src/system-line.ts'),'export function systemLine(db:unknown,input:unknown) {}'],
    [path, `import {systemLine} from './system-line.js';
      class DaemonService {
        postRoomMessage(input:any) { systemLine(db,{verb:input.text}); }
        execute() { this.postRoomMessage({presentation:'message',text:'ordinary reply'}); }
      }`],
  ]);
  const ordinary = new Map(files);
  ordinary.set(path,files.get(path)!.replace('ordinary reply','another ordinary reply'));
  expect(() => enforce(scan(ordinary),scan(files))).not.toThrow();
  const card = new Map(files);
  card.set(path,files.get(path)!.replace("presentation:'message'","presentation:'card'"));
  const changed = new Map(card);
  changed.set(path,card.get(path)!.replace('ordinary reply','changed card wording'));
  expect(() => enforce(scan(changed),scan(card))).toThrow(failure);
});

it('SYSTEM-REFACTOR-2: keeps array values and selection method identity locked', () => {
  const base=fixture("const words=['hello','world']; line(db,{verb:words.find(word=>word==='hello')});");
  for (const text of ["const words=['goodbye','world']; line(db,{verb:words.find(word=>word==='hello')});",
    "const words=['hello','world']; line(db,{verb:words.filter(word=>word==='hello')});"]) {
    const changed=fixture(text);
    expect(() => enforce(scan(changed),scan(base))).toThrow(failure);
  }
});

it.each(['find', 'filter', 'sort'])('SYSTEM-REFACTOR-2: locks %s callbacks selecting literal phrase data', (method) => {
  const original = method === 'sort' ? "(a,b)=>a==='hello'?-1:1" : "word=>word==='hello'";
  const changed = original.replace('hello', 'world');
  for (const setup of [
    "const words=['hello','world'];",
    "const phrases=['hello','world']; const words=phrases;",
    "const phrases=['hello','world']; const words=[...phrases];",
    "function phrases(): string[] { return ['hello','world']; } const words=phrases();",
  ]) {
    const source = `${setup} line(db,{verb:words.${method}(${original})});`;
    expect(() => enforce(scan(fixture(source.replace(original, changed))), scan(fixture(source)))).toThrow(failure);
  }
});

it.each(['find', 'filter', 'sort'])('SYSTEM-REFACTOR-2: locks %s callbacks on helper-forwarded phrase arrays', (method) => {
  const original = method === 'sort' ? "(a,b)=>a==='hello'?-1:1" : "word=>word==='hello'";
  const changed = original.replace('hello', 'world');
  const source = `
    function forward(words: string[]): string[] { return words; }
    function select(words: string[]) { return forward(words).${method}(${original}); }
    line(db,{verb:select(['hello','world'])});
  `;
  expect(() => enforce(scan(fixture(source.replace(original, changed))), scan(fixture(source)))).toThrow(failure);
});

it.each(['find', 'filter', 'sort'])('SYSTEM-REFACTOR-2: locks %s callbacks through destructured bindings', (method) => {
  const original = method === 'sort' ? "(a,b)=>a==='hello'?-1:1" : "word=>word==='hello'";
  const setups = [
    "function forward({words}:{words:string[]}):string[] { return words; } const selected=forward({words});",
    "function forward({words:w}:{words:string[]}):string[] { return w; } const selected=forward({words});",
    "function forward({nested:{words}}:any):string[] { return words; } const selected=forward({nested:{words}});",
    "function forward({words=['hello','world']}={}):string[] { return words; } const selected=forward();",
    "function forward([words]:string[][]):string[] { return words; } const selected=forward([words]);",
    "function forward([...words]:string[]):string[] { return words; } const selected=forward(words);",
    "function forward({ignored,...rest}:any):string[] { return rest.words; } const selected=forward({words});",
    "const {nested:{words:selected}}={nested:{words}};",
    "const [selected]=[words];",
    "const [...selected]=words;",
    "const {words:selected=['hello','world']}={};",
    "const {[unknownKey]:selected}=unresolvedSource;",
  ];
  for (const setup of setups) {
    const source = `function select(words:string[]) { ${setup} return selected.${method}(${original}); }
      line(db,{verb:select(['hello','world'])});`;
    const before = scan(fixture(source));
    const after = scan(fixture(source.replace(original, original.replace('hello', 'world'))));
    expect(compare(after, before).violations, setup).not.toEqual([]);
    expect(() => enforce(after, before), setup).toThrow(failure);
  }
});

it('SYSTEM-REFACTOR-2: fails closed for an unresolvable destructured array origin', () => {
  const source = "function forward({[unknownKey]:words}:any):string[] { return words; } line(db,{verb:forward(unresolvedSource).find(word=>word==='hello')});";
  const before = scan(fixture(source));
  const after = scan(fixture(source.replace("==='hello'", "==='world'")));
  expect(compare(after, before).violations).not.toEqual([]);
  expect(() => enforce(after, before)).toThrow(failure);
});

it('keeps imported wording changes locked when the producer source is reused', () => {
  const base = fixture();
  base.set('/fixtures/words.ts', "export const phrase = 'joined';");
  base.set('/fixtures/producer.ts', `
    import { systemLine as line } from './system-line.js';
    import { phrase } from './words.js';
    line(db, { verb: phrase });
  `);
  const baseline = scan(base);
  const changed = new Map(base);
  changed.set('/fixtures/words.ts', "export const phrase = 'left';");
  expect(() => enforce(scan(changed), baseline)).toThrow(failure);
  // Returning to the original graph must still reproduce its original entries.
  expect(scan(new Map(base))).toEqual(baseline);
});

it('keeps producer removals locked after scanning the same graph', () => {
  const base = fixture();
  const baseline = scan(base);
  expect(scan(new Map(base))).toEqual(baseline);
  const removed = new Map(base);
  removed.delete('/fixtures/producer.ts');
  expect(() => enforce(scan(removed), baseline)).toThrow(failure);
});
