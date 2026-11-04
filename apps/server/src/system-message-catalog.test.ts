import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';
import {
  SYSTEM_MESSAGE_CATALOG,
  systemMessage,
  type SystemMessageKey,
} from '../../../packages/api-contract/src/system-message-catalog.js';
import {
  assertCatalogUsage,
  assertCatalogShape,
  readWordingCatalog,
} from '../scripts/system-message-guard.js';
import { scanSystemMessageWording, systemMessageSources } from '../scripts/system-message-scan.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const catalogSource = () =>
  readFileSync(resolve(root, 'packages/api-contract/src/system-message-catalog.ts'), 'utf8');
const files = () =>
  new Map([
    ...systemMessageSources(resolve(root, 'apps/server/src')),
    ...systemMessageSources(resolve(root, 'packages/api-contract/src')),
  ]);

// A Vitest timeout cannot interrupt synchronous TypeScript graph traversal.
// The parent owns this deadline even if analysis stops servicing its event loop.
const SCAN_TIMEOUT_MS = 90_000;
function assertSourceUsage(sources: Map<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../scripts/system-message-scan-worker.mjs', import.meta.url), {
      workerData: [...sources],
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error(`System-message source scan exceeded ${SCAN_TIMEOUT_MS}ms`));
    }, SCAN_TIMEOUT_MS);
    worker.once('message', () => { clearTimeout(timer); resolve(); });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`System-message source scan exited before reporting success (code ${code})`));
    });
  });
}

it('validates catalog template shape while allowing wording changes', () => {
  assertCatalogShape(readWordingCatalog(catalogSource()));
});

it('requires every System writer to use catalog keys for fixed text', async () => {
  await assertSourceUsage(files());
}, SCAN_TIMEOUT_MS + 10_000);

const render = systemMessage as (key: SystemMessageKey, ...values: unknown[]) => string;
it.each(Object.entries(SYSTEM_MESSAGE_CATALOG))('renders catalog slots: %s', (key, entry) => {
  const values = entry.variables.map((_, index) => `value-${index}`);
  const expected = entry.parts.reduce((text, part, index) => text + (index ? values[index - 1] : '') + part, '');
  expect(render(key as SystemMessageKey, ...values)).toBe(expected);
});

it('allows added, removed and reworded phrases for weekly review', () => {
  const catalog = readWordingCatalog(catalogSource());
  const key = Object.keys(catalog)[0]!;
  catalog[key]!.parts = [catalog[key]!.parts[0] + ' changed', ...catalog[key]!.parts.slice(1)];
  delete catalog[Object.keys(catalog)[1]!];
  assertCatalogShape({ ...catalog, invented: { parts: ['New notice'], variables: [] } });
});

it('rejects malformed slots and reserved prototype keys', () => {
  expect(() => assertCatalogShape({ bad: { parts: ['text'], variables: ['missing slot'] } })).toThrow(/Invalid/);
  expect(() => assertCatalogShape(Object.fromEntries([['__proto__', { parts: ['text'], variables: [] }]]))).toThrow(/Invalid/);
});

it('an unrelated edit to each formerly locked method passes the real source scan', async () => {
  const changed = files();
  for (const [file, method] of [
    ['daemon-service.ts', 'postRoomMessage'],
    ['phone-service.ts', 'sendMessage'],
    ['phone-service.ts', 'sendReply'],
    ['rooms-mcp-agent.ts', 'call'],
  ]) {
    const path = resolve(root, 'apps/server/src', file!);
    const source = changed.get(path)!;
    const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    let body: ts.Block | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isMethodDeclaration(node) && node.name.getText(tree) === method && node.body)
        body = node.body;
      ts.forEachChild(node, visit);
    };
    visit(tree);
    expect(body, `${file}.${method} exists`).toBeDefined();
    const position = body!.getStart(tree) + 1;
    changed.set(
      path,
      source.slice(0, position) +
        '\nconst unrelatedRefactor = "diagnostic only"; void unrelatedRefactor;\n' +
        source.slice(position),
    );
  }
  assertCatalogShape(readWordingCatalog(catalogSource()));
  await assertSourceUsage(changed);
}, SCAN_TIMEOUT_MS + 10_000);

function fixture(source: string, helper = '') {
  return new Map([
    [
      '/fixture/system-line.ts',
      'export function systemLine(db: unknown, input: unknown) {} export function restateSystemLine(db: unknown, id: string, input: unknown) {}',
    ],
    ['/fixture/helper.ts', helper],
    [
      '/fixture/writer.ts',
      `import { systemLine as line, restateSystemLine as restate } from './system-line.js'; import { words } from './helper.js'; ${source}`,
    ],
  ]);
}

it.each([
  "line(db, {verb:'joined'});",
  "const {verb}={verb:'joined'}; line(db,{verb});",
  "line(db,{verb:systemMessage('notice'),cardType:'notice',card:{title:JSON.stringify({text:'inline serialized title'})}});",
  'line(db, {verb:`joined ${person}`});',
  "const word='joined'; line(db,{verb:word});",
  "const phrase={text:'a Room'}; line(db,{verb:systemMessage('joined'),object:phrase});",
  "function note(phrase:any){return line(db,phrase)} note({verb:'joined'});",
  "const alias=line; alias(db,{verb:'joined'});",
  "line.call(null, db, {verb:'joined'});",
  "const emit=line.bind(null,db); emit({verb:'joined'});",
  "restate(db, id, {verb:'joined'});",
  'line(db,{verb:words()});',
  "line(db,{verb:['joined','left'].join(' ')});",
  "line(db,{verb:systemMessage('notice','inline wording')});",
  "line(db,{verb:systemMessage('notice'),cardType:'notice',card:{title:'inline title'}});",
  "db.query(\"INSERT INTO messages(id,text,presentation) VALUES($1,'hello','system')\",[id]);",

  `db.query("UPDATE messages SET system_event=jsonb_set(system_event,'{verb}',to_jsonb('hello'::text)) WHERE id=$1",[id]);`,
  `db.query("UPDATE messages SET card=jsonb_build_object('title','Hello') WHERE id=$1",[id]);`,
  `line(db,{verb:db.query("SELECT 'hello' AS phrase").rows[0].phrase});`,
  "const render=systemMessage.bind(null,'notice'); line(db,{verb:render('inline wording')});",
])('rejects inline wording through a System sink: %s', (source) => {
  expect(() =>
    assertCatalogUsage(
      scanSystemMessageWording(fixture(source, "export function words(){return 'joined'}")),
    ),
  ).toThrow(/Add\/use a key/);
});

it.each([
  "line(db,{verb:systemMessage('notice'),object:person.name});",
  "line(db,{verb:systemMessage('notice'),kind:'member-joined',id:'wire-id',card:{status:'pending'}});",
  "const diagnostics='unrelated logger text'; console.log(diagnostics); line(db,{verb:systemMessage('notice')});",
  "if (permission==='owner') line(db,{verb:systemMessage('notice')});",
  'line(db,{verb:provider.read(),object:person.name});',
  "db.query(\"SELECT name FROM identities WHERE role='member'\"); line(db,{verb:systemMessage('notice')});",
])('allows dynamic data and unrelated writer implementation: %s', (source) => {
  assertCatalogUsage(scanSystemMessageWording(fixture(source)));
});
