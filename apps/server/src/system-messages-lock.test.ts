// Do not delete, disable or modify this guard or its list without lunchboxfortwo's express command.
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
  const queryResult = (node: ts.Node) => {
    const target = ts.isCallExpression(node)
      ? node.expression
      : ts.isTaggedTemplateExpression(node)
        ? node.tag
        : undefined;
    return !!target && ['query', 'sql', 'execute'].some((name) => targets(target, name));
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
  // A query reached through returned phrase data can supply wording. Track
  // SELECT/RETURNING expressions, never FROM, JOIN, WHERE or lock clauses.
  const queryWording = (node: ts.Node): { literals: string[]; parts: ts.Node[] } => {
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
    const tokens =
      render(query).match(
        /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|\$\d+|__expression_\d+__|[a-zA-Z_][\w]*|[^\s]/g,
      ) ?? [];
    const projections = new Map<number, boolean>();
    const conditions: boolean[] = [];
    const literals: string[] = [];
    const parts: ts.Node[] = [];
    let depth = 0;
    for (const token of tokens) {
      if (token.startsWith('--') || token.startsWith('/*')) continue;
      if (token === '(') depth++;
      if (token === ')') projections.delete(depth--);
      if (/^(select|returning)$/i.test(token)) projections.set(depth, true);
      if (
        projections.has(depth) &&
        /^(from|where|join|group|having|order|limit|offset|union|intersect|except|for)$/i.test(
          token,
        )
      )
        projections.set(depth, false);
      const active = [...projections]
        .filter(([level]) => level <= depth)
        .sort(([a], [b]) => b - a)[0]?.[1];
      if (/^case$/i.test(token)) conditions.push(false);
      if (/^when$/i.test(token) && conditions.length) conditions[conditions.length - 1] = true;
      if (/^(then|else)$/i.test(token) && conditions.length)
        conditions[conditions.length - 1] = false;
      if (/^end$/i.test(token)) conditions.pop();
      if (!active || conditions.some(Boolean)) continue;
      if (token.startsWith("'")) literals.push(token);
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
  const writes = new Map<ts.Node, { template: string; parts: ts.Node[] }>();
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
    const tokens =
      text.match(
        /'(?:''|[^'])*'|"(?:""|[^"])*"|\$\d+|__expression_\d+__|[a-zA-Z_][\w]*|::|[^\s]/g,
      ) ?? [];
    const lower = (token: string | undefined) => {
      const expression = token && /^__expression_(\d+)__$/.exec(token);
      return (expression ? sqlText(expressions[Number(expression[1])]!) : token)
        ?.replaceAll('"', '')
        .toLowerCase();
    };
    const parts: ts.Node[] = [];
    const outputs: string[] = [];
    const project = (tokens: string[], capture = false): string =>
      tokens
        .map((token) => {
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
    // Assigned expressions supply words and formatting. A nested SELECT's
    // FROM/WHERE clauses select rows, rather than supplying phrase text.
    const wording = (tokens: string[]) => {
      let depth = 0;
      let skip: number | undefined;
      const selects = new Set<number>();
      return tokens.filter((token) => {
        if (token === '(') depth++;
        if (token === ')') {
          if (skip !== undefined && depth === skip) skip = undefined;
          selects.delete(depth--);
        }
        if (lower(token) === 'select') selects.add(depth);
        if (selects.has(depth) && /^(from|where)$/.test(lower(token) ?? '')) skip ??= depth;
        return skip === undefined;
      });
    };
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
              .map((name) => `${name}=${assigned(name, true)}`)
              .join(', '),
        );
      }
    }
    if (outputs.length) writes.set(node, { template: outputs.join('\n'), parts });
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
  const phraseParts = (node: ts.Node): ts.Node[] =>
    ts.isObjectLiteralExpression(node)
      ? node.properties.flatMap((property) =>
          ts.isSpreadAssignment(property)
            ? [property.expression]
            : ts.isShorthandPropertyAssignment(property)
              ? [property.name]
              : ts.isPropertyAssignment(property) &&
                  /^(subject|verb|object|consequence|attribution|text|body|title|description|label|name|ask|card|cardType|card_type)$/.test(
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
    const parts =
      kind === 'restateSystemLine'
        ? call.arguments[2]
          ? phraseParts(call.arguments[2])
          : []
        : kind === 'systemLine'
          ? call.arguments[1]
            ? phraseParts(call.arguments[1])
            : []
          : (writes.get(node)?.parts ?? []);
    forward(node, parts);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const call of calls) {
      const indices = new Set(
        callableDeclarations(call.expression).flatMap((declaration) => [
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
    const id = `${file}:${scope.join('.') || 'module'}:${kind}:${createHash('sha256').update(template).digest('hex').slice(0, 16)}`;
    const literals = new Set<string>();
    const seen = new Set<ts.Node>();
    const collect = (part: ts.Node) => {
      if (seen.has(part)) return;
      seen.add(part);
      // Returned SQL expressions may supply words; access clauses do not.
      if (queryResult(part)) {
        const selected = queryWording(part);
        selected.literals.forEach((literal) => literals.add(literal));
        selected.parts.forEach(collect);
        return;
      }
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
          if (ts.isVariableDeclaration(declaration))
            (symbol(declaration.name)
              ? (mutations.get(symbol(declaration.name)!) ?? [])
              : []
            ).forEach(collect);
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
    };
    // The database argument is transport, not a phrase dependency.
    if (ts.isCallExpression(node) && kind === 'systemLine') {
      if (node.arguments[1]) phraseParts(node.arguments[1]).forEach(collect);
    } else if (ts.isCallExpression(node) && kind === 'restateSystemLine') {
      if (node.arguments[2]) phraseParts(node.arguments[2]).forEach(collect);
    } else if (writes.has(node)) writes.get(node)!.parts.forEach(collect);
    else if (kind === 'wrapper' && ts.isCallExpression(node)) {
      const indices = callableDeclarations(node.expression).flatMap((declaration) => [
        ...(wrappers.get(functions.get(declaration) ?? declaration) ?? []),
      ]);
      indices.forEach((index) => {
        if (node.arguments[index]) collect(node.arguments[index]!);
      });
    } else collect(node);
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
        entry.occurrences !== prior.occurrences
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

it('keeps ordinary agent reports outside the System lock', () => {
  const changed = fixture(
    "export function added(db: any, options: any) { reportToCommander(db, room, SYSTEM_IDENTITY_ID, 'new public report', undefined, 'id', {agentOnly: true, ...options}); }",
  );
  expect(compare(scan(changed), scan(fixture())).violations).toEqual([]);
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
      const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
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
