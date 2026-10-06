import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { chromium } = await import('/home/lunchbox/gstack/node_modules/playwright-core/index.mjs');
const browser = await chromium.launch({ executablePath: '/home/lunchbox/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell', args: ['--no-sandbox'] });
const page = await browser.newPage();
const source = await readFile('apps/mobile/sources/app/(app)/beeline/chat/_chat-surface.tsx', 'utf8');
const start = source.indexOf('  useLayoutEffect(() => {', source.indexOf('// Older history paging'));
const effect = source.slice(start + '  useLayoutEffect(() => {'.length, source.indexOf('  }, [desktopTranscript, transcriptMessages]);', start));
const browserEffect = effect.replace('row: HTMLElement', 'row').replaceAll('node!', 'node');
const result = await page.evaluate(async ({ effect, source }) => {
  document.body.innerHTML = '<div id="scroll" style="height:300px;overflow:auto"><div id="content"></div></div>';
  const node = document.getElementById('scroll');
  if (source.includes("overflowAnchor: 'none'")) node.style.overflowAnchor = 'none';
  const content = document.getElementById('content');
  const desktopScrollNodeRef = {current:node};
  const desktopRowNodesRef = {current:new Map()};
  const desktopPrependOldestIdRef = {current:null};
  const desktopPrependScrollHeightRef = {current:null};
  const desktopPrependOffsetRef = {current:null};
  let transcriptMessages = [];
  const desktopTranscript = true;
  const commit = () => eval('(() => {' + effect + '})()');
  const add = (id, prepend=false) => {
    const row = document.createElement('div'); row.style.height='50px'; row.textContent=id;
    desktopRowNodesRef.current.set(id,row);
    if(prepend) {content.prepend(row);transcriptMessages.unshift({id});}
    else {content.append(row);transcriptMessages.push({id});}
  };
  for(let i=0;i<60;i++) add('m'+i);
  commit(); node.scrollTop=900;
  await new Promise(requestAnimationFrame);
  const row = desktopRowNodesRef.current.get('m18');
  const before = row.getBoundingClientRect().top;
  for(let i=0;i<10;i++) add('old'+i,true);
  add('live'); commit();
  await new Promise(requestAnimationFrame);
  const after = row.getBoundingClientRect().top;
  return {before,after,drift:after-before,scrollTop:node.scrollTop};
}, {effect:browserEffect,source});
console.log('Reproduction corner-history-scroll: read m18, load 10 older rows and append live work',result);
await browser.close();
assert.equal(result.drift,0,'Reading position must remain stable');
