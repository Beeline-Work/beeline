// Structural sink discovery; only phrase values are scanned, never writer bodies.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
const server = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function systemMessageSources(directory: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) for (const pair of systemMessageSources(path)) files.set(...pair);
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
  if (!versions) parsedSources.set(path, (versions = new Map()));
  let source = versions.get(text);
  if (!source) {
    source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    versions.set(text, source);
  }
  return source;
}

// Reuse analysis only when the entire input graph (including order) is identical.
// Changed imports, removed files and changed dependency text all require a scan.
const scannedSources = new Map<string, ts.Node[]>();

/** Parse symbols, not source substrings: aliases and wrappers retain their sink identity. */
export function scanSystemMessageWording(files: Map<string, string>): ts.Node[] {
  const key = createHash('sha256')
    .update(JSON.stringify([...files]))
    .digest('hex');
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
    files.has(path) ? parsedSource(path, files.get(path)!) : undefined;
  host.fileExists = (path) => files.has(path);
  host.readFile = (path) => files.get(path);
  host.resolveModuleNames = (names, containing) =>
    names.map((name) => {
      const path = name.startsWith('@beeline/api-contract/')
        ? resolve(
            server,
            '../../packages/api-contract/src',
            name.slice('@beeline/api-contract/'.length) + '.ts',
          )
        : resolve(dirname(containing), name.replace(/\.js$/, '.ts'));
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
    while (commandOwner && !ts.isFunctionDeclaration(commandOwner))
      commandOwner = commandOwner.parent;
    if (
      commandOwner &&
      ts.isFunctionDeclaration(commandOwner) &&
      commandOwner.name?.text === 'createAgentCommand' &&
      commandOwner.getSourceFile().fileName === resolve(server, 'src/agent-command.ts') &&
      /\b(?:FROM|INTO)\s+agent_commands\b/i.test(queryText) &&
      /\b(?:SELECT|RETURNING)\s+\*/i.test(queryText)
    )
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
    if (!result) queryWords.set(node, (result = queryWordingUncached(node)));
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
  const writes = new Map<ts.Node, { parts: ts.Node[]; literals: string[] }>();
  const inlineSql = new Set<ts.Node>();
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
    if (/SET\s+presentation\s*=\s*'activity'/i.test(text)) return;
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
    let foundWrite = false;
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
            return '$bound';
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
        const assignedText = wording(fields.get('text') ?? []);
        if (
          assignedText.some(
            (token, index) =>
              /^'(?:''|[^'])+'$/.test(token) &&
              token !== "''" &&
              !/^'\{/.test(token) &&
              !['>', '-'].includes(assignedText[index - 1] ?? ''),
          )
        )
          inlineSql.add(node);
        // JSON paths and object keys are metadata; their displayed values are wording.
        const visibleJsonKey =
          /^(?:verb|consequence|name|text|title|label|description|help|detail|question|ask|prompt|footer)$/;
        const sqlString = (token: string | undefined) =>
          token?.startsWith("'") && token.endsWith("'")
            ? token.slice(1, -1).replaceAll("''", "'")
            : undefined;
        const jsonHasWords = (value: unknown): boolean => {
          if (Array.isArray(value)) return value.some(jsonHasWords);
          return (
            !!value &&
            typeof value === 'object' &&
            Object.entries(value).some(
              ([key, part]) =>
                (visibleJsonKey.test(key) && typeof part === 'string' && part.length > 0) ||
                jsonHasWords(part),
            )
          );
        };
        for (const field of ['card', 'system_event']) {
          const tokens = wording(fields.get(field) ?? []);
          for (let index = 0; index < tokens.length; index++) {
            const value = sqlString(tokens[index]);
            if (!value) continue;
            if (
              visibleJsonKey.test(value) &&
              tokens[index + 1] === ',' &&
              sqlString(tokens[index + 2])
            )
              inlineSql.add(node);
            if (
              /^\{(?:subject,name|object,text|verb|consequence|title|text|label|description|ask|prompt|footer)\}$/.test(
                value,
              )
            ) {
              // Inspect the assigned JSON scalar after this path, not path selectors before it.
              const tail = tokens.slice(index + 1);
              if (
                tail.some(
                  (token, offset) =>
                    !!sqlString(token) &&
                    !/^'\{/.test(token) &&
                    !['>', '-'].includes(tail[offset - 1] ?? ''),
                )
              )
                inlineSql.add(node);
            }
            try {
              if (jsonHasWords(JSON.parse(value))) inlineSql.add(node);
            } catch {
              /* Not a JSON literal. */
            }
          }
        }
        for (const name of visible) assigned(name, true);
        foundWrite = true;
      }
    }
    if (foundWrite) writes.set(node, { parts, literals: sqlLiterals });
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
    if (named(call, 'systemLine')) {
      const input = invocationArguments(call)[1];
      if (!(
        input &&
        ts.isObjectLiteralExpression(input) &&
        input.properties.some(
          (property) =>
            ts.isPropertyAssignment(property) &&
            property.name.getText() === 'presentation' &&
            ts.isStringLiteralLike(property.initializer) &&
            property.initializer.text === 'activity',
        )
      ))
        direct.set(call, 'systemLine');
    } else if (named(call, 'restateSystemLine')) direct.set(call, 'restateSystemLine');
    else if (call.arguments[0]) sqlWrite(call, call.arguments[0], call.arguments[1]);
  }
  for (const node of writes.keys()) direct.set(node, 'message-write');
  for (const card of cards)
    if (
      !card.properties.some(
        (property) =>
          ts.isPropertyAssignment(property) &&
          property.name.getText() === 'presentation' &&
          ts.isStringLiteralLike(property.initializer) &&
          property.initializer.text === 'activity',
      ) &&
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
    !/^(subject|verb|object|consequence|attribution|name|text|title|description|label|help|detail|question|ask|prompt|options|choices|message|errorMessage|fault|actions|fields|summary|body|line|phrase|footer|constraint|does)$/.test(
      name.text,
    );
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
          if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property))
            return [];
          const name = property.name;
          const transport =
            (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) &&
            /^(id|roomId|authorId|kind|scheduleId|payload|subscriptionPrompt|subscriptionWorkflowSlug|wakes|presentation|cardType|card_type|requestId|commandId|durableFact|causeId|afterMessageId)$/.test(
              name.text,
            );
          if (transport) return [];
          return [ts.isPropertyAssignment(property) ? property.initializer : name];
        })
      : [node];
  // A binding's container carries every possible selected value. Keep defaults
  // at every nesting level as additional origins, including rest bindings.
  const bindingOrigin = (binding: ts.BindingElement) => {
    const defaults: ts.Expression[] = [];
    let root: ts.Node = binding;
    while (
      ts.isBindingElement(root) ||
      ts.isObjectBindingPattern(root) ||
      ts.isArrayBindingPattern(root)
    ) {
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
      if (ts.isConditionalExpression(part)) {
        inspect(part.whenTrue);
        inspect(part.whenFalse);
        return;
      }
      if (
        ts.isBinaryExpression(part) &&
        ![
          ts.SyntaxKind.PlusToken,
          ts.SyntaxKind.QuestionQuestionToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.AmpersandAmpersandToken,
        ].includes(part.operatorToken.kind)
      )
        return;
      if (ts.isObjectLiteralExpression(part)) {
        wordingParts(part).forEach(inspect);
        return;
      }
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
    (call.arguments[0] &&
      ts.isStringLiteralLike(call.arguments[0]) &&
      /^(sendRoomMessage|sendRoomReply)$/.test(call.arguments[0].text) &&
      callableDeclarations(call.expression).some(
        (declaration) =>
          ts.isMethodDeclaration(declaration) &&
          declaration.name.getText() === 'execute' &&
          declaration.getSourceFile().fileName === resolve(server, 'src/phone-service.ts'),
      )) ||
    (callableDeclarations(call.expression).some(
      (declaration) =>
        ts.isMethodDeclaration(declaration) &&
        declaration.name.getText() === 'postRoomMessage' &&
        declaration.getSourceFile().fileName === resolve(server, 'src/daemon-service.ts'),
    ) &&
      call.arguments[0] &&
      ts.isObjectLiteralExpression(call.arguments[0]) &&
      call.arguments[0].properties.some(
        (property) =>
          ts.isPropertyAssignment(property) &&
          property.name.getText() === 'presentation' &&
          ts.isStringLiteralLike(property.initializer) &&
          property.initializer.text === 'message',
      ) &&
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

  const found = new Set<ts.Node>();
  const active = new Set<ts.Node>();
  let bindings = new Map<ts.Node, ts.Node>();
  const returns = (fn: ts.Node) => {
    const result: ts.Node[] = [];
    if (!ts.isFunctionLike(fn) || !('body' in fn) || !fn.body) return result;
    if (!ts.isBlock(fn.body as ts.Node)) return [fn.body as ts.Node];
    const visit = (part: ts.Node) => {
      if (ts.isReturnStatement(part) && part.expression) result.push(part.expression);
      else if (!ts.isFunctionLike(part)) ts.forEachChild(part, visit);
    };
    ts.forEachChild(fn.body as ts.Node, visit);
    return result;
  };
  const selected = (part: ts.Node, name: string, seen = new Set<ts.Node>()): ts.Node[] => {
    if (seen.has(part)) return [];
    seen.add(part);
    if (ts.isParenthesizedExpression(part) || ts.isAsExpression(part) || ts.isAwaitExpression(part))
      return selected(part.expression, name, seen);
    if (ts.isConditionalExpression(part))
      return [...selected(part.whenTrue, name, seen), ...selected(part.whenFalse, name, seen)];
    if (ts.isObjectLiteralExpression(part))
      return part.properties.flatMap((property) => {
        if (ts.isSpreadAssignment(property)) return selected(property.expression, name, seen);
        if (
          (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
          property.name.getText().replace(/['"]/g, '') === name
        )
          return [ts.isPropertyAssignment(property) ? property.initializer : property.name];
        return [];
      });
    if (ts.isCallExpression(part))
      return callableDeclarations(part.expression).flatMap((declaration) =>
        returns(functions.get(declaration) ?? declaration).flatMap((value) =>
          selected(value, name, seen),
        ),
      );
    if (ts.isIdentifier(part))
      return declarations(part).flatMap((declaration) => {
        const value =
          bindings.get(declaration) ??
          (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration)
            ? declaration.initializer
            : undefined);
        return value ? selected(value, name, seen) : [];
      });
    if (ts.isPropertyAccessExpression(part))
      return selected(part.expression, part.name.text, seen).flatMap((value) =>
        selected(value, name, seen),
      );
    return [];
  };
  const collectField = (part: ts.Node, name: string, seen = new Set<ts.Node>()): void => {
    if (seen.has(part)) return;
    seen.add(part);
    if (ts.isParenthesizedExpression(part) || ts.isAsExpression(part) || ts.isAwaitExpression(part))
      return collectField(part.expression, name, seen);
    if (ts.isConditionalExpression(part)) {
      collectField(part.whenTrue, name, seen);
      collectField(part.whenFalse, name, seen);
      return;
    }
    if (ts.isObjectLiteralExpression(part)) {
      for (const property of part.properties) {
        if (ts.isSpreadAssignment(property)) collectField(property.expression, name, seen);
        else if (
          (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
          property.name.getText().replace(/['"]/g, '') === name
        )
          collect(ts.isPropertyAssignment(property) ? property.initializer : property.name);
      }
      return;
    }
    if (ts.isCallExpression(part)) {
      if (queryResult(part)) {
        const query = part.arguments[0];
        const tokens = wordingTokens(sqlTokens(query ? sqlText(query) : ''));
        for (let index = 0; index < tokens.length; index++) {
          if (tokens[index]?.replaceAll('"', '').toLowerCase() !== name.toLowerCase()) continue;
          const end = tokens[index - 1]?.toLowerCase() === 'as' ? index - 1 : index;
          let start = end - 1,
            depth = 0;
          for (; start >= 0; start--) {
            const token = tokens[start]!;
            if (token === ')') depth++;
            if (token === '(') {
              if (!depth) break;
              depth--;
            }
            if (!depth && (token === ',' || /^select$/i.test(token))) break;
          }
          const output = tokens.slice(start + 1, end);
          if (
            output.some(
              (token, offset) =>
                /^'(?:''|[^'])+'$/.test(token) &&
                token !== "''" &&
                !['>', '-'].includes(output[offset - 1] ?? ''),
            )
          )
            found.add(part);
        }
        queryWording(part).parts.forEach(collect);
        return;
      }
      for (const declaration of callableDeclarations(part.expression)) {
        const fn = functions.get(declaration) ?? declaration;
        if (!ts.isFunctionLike(fn)) continue;
        const saved = bindings;
        bindings = new Map(bindings);
        fn.parameters.forEach((parameter, index) => {
          const value = invocationArguments(part)[index] ?? parameter.initializer;
          if (value) bindings.set(parameter, value);
        });
        returns(fn).forEach((value) => collectField(value, name, new Set(seen)));
        bindings = saved;
      }
      return;
    }
    if (ts.isIdentifier(part)) {
      for (const declaration of declarations(part)) {
        const value =
          bindings.get(declaration) ??
          (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration)
            ? declaration.initializer
            : undefined);
        if (value) collectField(value, name, seen);
      }
    }
    if (ts.isElementAccessExpression(part)) collectField(part.expression, name, seen);
    if (ts.isPropertyAccessExpression(part)) {
      if (part.name.text === 'rows') collectField(part.expression, name, seen);
      else
        selected(part.expression, part.name.text).forEach((value) =>
          collectField(value, name, seen),
        );
    }
  };
  const collectValues = (part: ts.Node, seen = new Set<ts.Node>()): void => {
    if (seen.has(part)) return;
    seen.add(part);
    if (ts.isObjectLiteralExpression(part)) {
      part.properties.forEach((property) => {
        if (ts.isPropertyAssignment(property)) collect(property.initializer);
        else if (ts.isShorthandPropertyAssignment(property)) collect(property.name);
        else if (ts.isSpreadAssignment(property)) collectValues(property.expression, seen);
      });
    } else if (ts.isIdentifier(part)) {
      for (const declaration of declarations(part)) {
        const value =
          bindings.get(declaration) ??
          (ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined);
        if (value) collectValues(value, seen);
      }
    } else collect(part);
  };
  const collect = (part: ts.Node) => {
    if (active.has(part) || ts.isTypeNode(part)) return;
    active.add(part);
    try {
      if (part.getSourceFile().fileName.endsWith('/system-message-catalog.ts')) return;
      if (ts.isStringLiteralLike(part)) {
        if (part.text) found.add(part);
        return;
      }
      if (ts.isTemplateExpression(part)) {
        if ([part.head.text, ...part.templateSpans.map((span) => span.literal.text)].some(Boolean))
          found.add(part);
        part.templateSpans.forEach((span) => collect(span.expression));
        return;
      }
      if (ts.isConditionalExpression(part)) {
        collect(part.whenTrue);
        collect(part.whenFalse);
        return;
      }
      if (ts.isBinaryExpression(part)) {
        if (
          [
            ts.SyntaxKind.PlusToken,
            ts.SyntaxKind.QuestionQuestionToken,
            ts.SyntaxKind.BarBarToken,
            ts.SyntaxKind.AmpersandAmpersandToken,
            ts.SyntaxKind.PlusEqualsToken,
            ts.SyntaxKind.EqualsToken,
          ].includes(part.operatorToken.kind)
        ) {
          if (part.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) collect(part.left);
          collect(part.right);
        }
        return;
      }
      if (ts.isObjectLiteralExpression(part)) {
        wordingParts(part).forEach(collect);
        return;
      }
      if (queryResult(part)) {
        queryWording(part).parts.forEach(collect);
        // SQL output literals are reported at the query, for conversion to bound catalog values.
        if (queryWording(part).literals.some((literal) => /[a-z]{2} /i.test(literal)))
          found.add(part);
        return;
      }
      if (ts.isCallExpression(part)) {
        if (named(part, 'systemMessage')) {
          invocationArguments(part).slice(1).forEach(collect);
          return;
        }
        if (
          (ts.isIdentifier(part.expression) && ['String'].includes(part.expression.text)) ||
          part.expression.getText() === 'JSON.stringify'
        ) {
          part.arguments.forEach(collect);
          return;
        }
        if (ts.isPropertyAccessExpression(part.expression)) {
          const method = part.expression.name.text;
          // Provider responses and database rows are data, not fixed message text.
          if (['issuesRequest', 'readCommitCheckRollup', 'appCardMark'].includes(method)) return;
          if (
            /^(map|flatMap|join|slice|substring|trim|trimEnd|trimStart|toLowerCase|toUpperCase|replace|replaceAll|filter|find|sort|concat|toString|toLocaleString|padStart|padEnd)$/.test(
              method,
            )
          ) {
            collect(part.expression.expression);
            if (/^(map|flatMap|join|concat|padStart|padEnd)$/.test(method))
              part.arguments.forEach(collect);
            if (/^replace/.test(method) && part.arguments[1]) collect(part.arguments[1]);
            return;
          }
        }
        const targets = callableDeclarations(part.expression).map(
          (declaration) => functions.get(declaration) ?? declaration,
        );
        for (const fn of targets) {
          if (!ts.isFunctionLike(fn)) continue;
          const saved = bindings;
          bindings = new Map(bindings);
          fn.parameters.forEach((parameter, index) => {
            const value = invocationArguments(part)[index] ?? parameter.initializer;
            if (value) bindings.set(parameter, value);
          });
          returns(fn).forEach(collect);
          bindings = saved;
        }
        return;
      }
      if (ts.isPropertyAccessExpression(part) || ts.isElementAccessExpression(part)) {
        const decls = declarations(part);
        for (const declaration of decls) {
          if (ts.isPropertyAssignment(declaration)) collect(declaration.initializer);
          if (ts.isVariableDeclaration(declaration) && declaration.initializer)
            collect(declaration.initializer);
        }
        const field = ts.isPropertyAccessExpression(part)
          ? part.name.text
          : ts.isStringLiteralLike(part.argumentExpression)
            ? part.argumentExpression.text
            : undefined;
        if (field) collectField(part.expression, field);
        else collectValues(part.expression);
        return;
      }
      if (ts.isIdentifier(part)) {
        for (const declaration of declarations(part)) {
          const bound = bindings.get(declaration);
          if (bound) collect(bound);
          else if (ts.isVariableDeclaration(declaration) && declaration.initializer)
            collect(declaration.initializer);
          else if (ts.isParameter(declaration) && declaration.initializer)
            collect(declaration.initializer);
          else if (ts.isBindingElement(declaration)) {
            const { root, defaults } = bindingOrigin(declaration);
            defaults.forEach(collect);
            if ((ts.isVariableDeclaration(root) || ts.isParameter(root)) && root.initializer)
              collect(root.initializer);
          }
          if (ts.isVariableDeclaration(declaration))
            (symbol(declaration.name)
              ? (mutations.get(symbol(declaration.name)!) ?? [])
              : []
            ).forEach(collect);
        }
        return;
      }
      if (
        ts.isArrowFunction(part) ||
        ts.isFunctionExpression(part) ||
        ts.isFunctionDeclaration(part)
      ) {
        returns(part).forEach(collect);
        return;
      }
      ts.forEachChild(part, collect);
    } finally {
      active.delete(part);
    }
  };
  for (const [node, kind] of direct) {
    if (node.getSourceFile().fileName.endsWith('/system-message-catalog.ts')) continue;
    const args = ts.isCallExpression(node) ? invocationArguments(node) : [];
    if (kind === 'systemLine' && args[1]) phraseParts(args[1]).forEach(collect);
    else if (kind === 'restateSystemLine' && args[2]) phraseParts(args[2]).forEach(collect);
    else if (writes.has(node)) {
      writes.get(node)!.parts.forEach(collect);
      if (
        inlineSql.has(node) ||
        writes.get(node)!.literals.some((literal) => /[a-z]{2} /i.test(literal))
      )
        found.add(node);
    } else if (kind === 'wrapper' && ts.isCallExpression(node)) {
      const indices = callableDeclarations(node.expression).flatMap((declaration) => [
        ...(wrappers.get(functions.get(declaration) ?? declaration) ?? []),
      ]);
      indices.forEach((index) => {
        if (args[index]) collect(args[index]!);
      });
    } else collect(node);
  }
  const result = [...found].sort(
    (a, b) =>
      a.getSourceFile().fileName.localeCompare(b.getSourceFile().fileName) ||
      a.getStart() - b.getStart(),
  );
  scannedSources.set(key, result);
  return result;
}
