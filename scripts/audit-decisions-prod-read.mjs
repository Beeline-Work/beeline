import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const source = readFileSync(new URL('./audit-decisions-cleanup.mjs', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('// Each predicate'), source.indexOf('if (process.argv[1]')).replaceAll('export ', '');
const runner = `const pg=require('/app/node_modules/pg');${body};(async()=>{const c=new pg.Client({connectionString:process.env.DATABASE_URL});try{await c.connect();console.log(JSON.stringify(await cleanup(c,false),null,2))}finally{await c.end()}})().catch(e=>{console.error(e.message);process.exitCode=1});`;
const encoded = Buffer.from(runner).toString('base64');
const result = spawnSync('flyctl', ['ssh', 'console', '-a', 'beeline-server', '--machine', '8d04d0ce21d2d8', '-C',
  `node -e eval(Buffer.from(process.argv[1],String.fromCharCode(98,97,115,101,54,52)).toString()) ${encoded}`], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
