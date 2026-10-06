import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { transform } from 'esbuild';
const { chromium } = await import(process.env.PLAYWRIGHT_CORE_PATH ?? '/home/lunchbox/gstack/node_modules/playwright-core/index.mjs');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/home/lunchbox/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell', args: ['--no-sandbox'] });
const page = await browser.newPage();
const source = await readFile('apps/mobile/sources/app/(app)/beeline/chat/_chat-surface.tsx', 'utf8');
const captureStart = source.indexOf('  const captureDesktopReadingAnchor = useCallback(() => {');
const capture = source.slice(captureStart + '  const captureDesktopReadingAnchor = useCallback(() => {'.length, source.indexOf('  }, []);', captureStart));
const start = source.indexOf('  useLayoutEffect(() => {', source.indexOf('// Older history paging'));
const effect = source.slice(start + '  useLayoutEffect(() => {'.length, source.indexOf('  }, [captureDesktopReadingAnchor, desktopTranscript, transcriptMessages]);', start));
const browserEffect = (await transform('(() => {' + effect + '})()', {loader:'ts'})).code;
const browserCapture = (await transform('(() => {' + capture + '})()', {loader:'ts'})).code;
const results = [];
for (const scenario of ['prepend-and-live', 'drop-oldest-and-live', 'live-only', 'reader-scroll-then-drop', 'pinned-tail']) {
const result = await page.evaluate(async ({ effect, source, scenario, capture }) => {
  document.body.innerHTML = '<div id="scroll" style="height:300px;overflow:auto"><div id="content"></div></div>';
  const node = document.getElementById('scroll');
  if (source.includes("overflowAnchor: 'none'")) node.style.overflowAnchor = 'none';
  const content = document.getElementById('content');
  const desktopScrollNodeRef = {current:node};
  const desktopRowNodesRef = {current:new Map()};
  const desktopReadingAnchorRef = {current:null};
  const isPinnedToTailRef = {current:false};
  const transcriptLandingAnchorIdRef = {current:null};
  const captureDesktopReadingAnchor = () => eval(capture);
  let transcriptMessages = [];
  const desktopTranscript = true;
  const commit = () => eval(effect);
  const add = (id, prepend=false) => {
    const row = document.createElement('div'); row.style.height='50px'; row.textContent=id;
    desktopRowNodesRef.current.set(id,row);
    if(prepend) {content.prepend(row);transcriptMessages.unshift({id});}
    else {content.append(row);transcriptMessages.push({id});}
  };
  for(let i=0;i<60;i++) add('m'+i);
  commit(); node.scrollTop=900;
  await new Promise(requestAnimationFrame);
  if (scenario === 'reader-scroll-then-drop') node.scrollTop = 1000;
  if (scenario === 'pinned-tail') {
    isPinnedToTailRef.current = true;
    node.scrollTop = node.scrollHeight;
  }
  captureDesktopReadingAnchor();
  const row = desktopRowNodesRef.current.get('m18');
  const before = row.getBoundingClientRect().top;
  if (scenario === 'prepend-and-live') {
    for(let i=0;i<10;i++) add('old'+i,true);
  } else if (scenario === 'drop-oldest-and-live' || scenario === 'reader-scroll-then-drop') {
    const removed = transcriptMessages.shift();
    desktopRowNodesRef.current.get(removed.id).remove();
    desktopRowNodesRef.current.delete(removed.id);
  }
  add('live'); commit();
  await new Promise(requestAnimationFrame);
  const after = row.getBoundingClientRect().top;
  return {before,after,drift:after-before,scrollTop:node.scrollTop};
}, {effect:browserEffect,source,scenario,capture:browserCapture});
console.log('Reproduction corner-history-scroll:',scenario,result);
results.push(result);
}
await browser.close();
for (const result of results) assert.equal(result.drift,0,'Reading position must remain stable');
