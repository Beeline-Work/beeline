import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {gzipSync} from 'node:zlib';
import {build} from 'esbuild';
import {entries,scenes,responses} from '../web/marketing/story.mjs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const html=read('web/index.html');
test('the real homepage has readable shared UI before the lazy controller loads',()=>{
 assert.match(html,/<h1 class="wordmark">/);assert.match(html,/data-native-room="hero"/);assert.match(html,/data-native-room="sync"/);assert.match(html,/data-native-room="context"/);
 assert.match(html,/tell me all user feedback/);assert.match(html,/aria-label="Message"/);assert.match(html,/aria-labelledby="stage-caption"/);
 assert.doesNotMatch(html,/gpt-5\.4|Join Beeline Community|room\.bundle\.js|fonts\.googleapis/);
 assert.match(read('web/marketing/boot.mjs'),/import\('\.\/demo\.js/);
});
test('production demo bundles only its local script and pre-rendered shared UI, within its transfer budget',async()=>{
 const result=await build({entryPoints:['web/marketing/demo-source.mjs'],bundle:true,minify:true,format:'esm',target:'es2022',write:false,metafile:true});
 assert.equal(read('web/marketing/demo.js'),result.outputFiles[0].text);
 assert.deepEqual(Object.keys(result.metafile.inputs).sort(),['web/marketing/demo-source.mjs','web/marketing/story.mjs','web/marketing/ui.json']);
 assert.ok(gzipSync(result.outputFiles[0].contents).length<25000,'lazy demo must remain below 25KB gzip');
 assert.ok(gzipSync(html).length<25000,'first paint must not contain the mobile runtime or base64 fonts');
 assert.doesNotMatch(read('web/marketing/demo-source.mjs'),/\bfetch\(|WebSocket|EventSource|setInterval|localStorage/);
});
test('script keeps the approved handoffs and banter stays a bounded, deterministic local response table',()=>{
 assert.equal(entries.length,15);assert.ok(scenes.some(s=>s.active.includes('codex')&&s.active.includes('claude')));
 assert.equal(entries.find(e=>e.who==='codex'&&e.system).at,15000);
 assert.deepEqual(responses('@Hermes make a video').map(r=>r.who),['hermes','claude']);
 assert.deepEqual(responses('@Codex use your tools'),responses('@Codex use your tools'));
 assert.equal(responses('<script>alert(1)</script>').length,2);
 assert.ok(responses('<script>alert(1)</script>').every(r=>!r.text.includes('<script>')));
});
test('all first-paint files and local WOFF2 faces are present within the font budget',()=>{
 for(const [,url] of html.matchAll(/(?:src|href)="(\/marketing\/[^"?]+)(?:\?[^" ]*)?"/g))assert.ok(fs.existsSync(new URL('../web'+url,import.meta.url)),url);
 let bytes=0;for(const [,url] of read('web/marketing/fonts.css').matchAll(/url\('([^']+)'\)/g)){const data=fs.readFileSync(new URL('../web/marketing/'+url,import.meta.url));assert.equal(data.subarray(0,4).toString(),'wOF2');bytes+=data.length;}
 assert.ok(bytes<400000,'local fonts must remain below 400KB');
});
