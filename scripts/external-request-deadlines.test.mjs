import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';

// Walk syntax rather than lines: multiline fetches and member clients (the
// storage signer and injected OIDC fetch) are subject to the same rule.
function unboundedCalls(source) {
  const file = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true);
  const failures = [];
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(file);
      if (/(^|[.#])(fetch|axios|got)$/.test(callee) || /^(axios|got|https|http)\./.test(callee)) {
        const options = node.arguments[1];
        const bounded =
          options &&
          ts.isObjectLiteralExpression(options) &&
          options.properties.some(
            (property) =>
              (ts.isShorthandPropertyAssignment(property) && property.name.text === 'signal') ||
              (ts.isPropertyAssignment(property) &&
                property.name.getText(file) === 'signal' &&
                property.initializer.getText(file) !== 'undefined' &&
                property.initializer.kind !== ts.SyntaxKind.NullKeyword),
          );
        if (!bounded)
          failures.push(
            `${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${callee}`,
          );
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return failures;
}

test('server and authentication outside calls carry deadlines', () => {
  const auth = readdirSync(new URL('../apps/auth/src/', import.meta.url)).filter(
    (name) =>
      name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'server-test-fixture.ts',
  );
  const server = readdirSync(new URL('../apps/server/src/', import.meta.url)).filter(
    (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
  );
  const paths = [
    ...auth.map((name) => `apps/auth/src/${name}`),
    ...server.map((name) => `apps/server/src/${name}`),
  ];
  const failures = paths.flatMap((path) =>
    unboundedCalls(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')).map(
      (failure) => `${path}:${failure}`,
    ),
  );
  assert.deepEqual(failures, [], 'Use externalFetch or provide an explicit deadline signal');
});

test('guard catches raw, multiline, member, and HTTP client calls', () => {
  assert.equal(
    unboundedCalls(
      `fetch(url); client.fetch(url, {method:'GET'}); https.request(url); axios.get(url);`,
    ).length,
    4,
  );
  assert.deepEqual(
    unboundedCalls(`fetch(url, {signal: AbortSignal.timeout(20_000)}); externalFetch(url);`),
    [],
  );
});
