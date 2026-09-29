/** Local display shim for the four approved x-dc boards.
 * The provided directory omits support.js and its /_blob store. This file
 * only unwraps the authored HTML and substitutes official app marks.
 */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../..');
const source = process.argv[2] ?? '/home/lunchbox/firstmate2/data/composio-apps-mock';
const output = resolve(root, 'apps/mobile/evidence/composio-apps-ui/mock');
await mkdir(output, { recursive: true });
await writeFile(resolve(output, 'agent-mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26"><rect width="26" height="26" rx="5" fill="#DBA5B5"/><text x="13" y="18" text-anchor="middle" font-family="sans-serif" font-size="15" fill="#1C1712">M</text></svg>');

const asset = (name) => pathToFileURL(resolve(root, `apps/mobile/assets/app-logos/${name}.png`)).href;
const favicon = (domain) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
const marks = {
  a775741d035c096005f01126470cfa28: asset('gmail'),
  '4f19338f4855c96692808d7fc678d68b': asset('calendar'),
  '2232e4031c798918112bf6f24ea37475': favicon('slack.com'),
  b415ce011bb8efb11fb8d3c7476af19d: asset('drive'),
  '122ab6e60ec4cc88b6b32ff067a5dcae': asset('sheets'),
  ac0629639769052914326a5912440edb: favicon('notion.so'),
  '5e28c9b37f716f7546dd4f76ed15b6ed': favicon('linear.app'),
  aaf3e7a167a8fce5ee5cea5feb38f680: favicon('hubspot.com'),
  ef9708f14a359b123bf36e54804741f2: favicon('airtable.com'),
  '6cef0550a16d87dcd9f082ccf691308a': favicon('asana.com'),
  e532748fb924f3c824d6e70ffa20bc08: favicon('atlassian.com'),
  f994a39fcd3a81c9ae18c5f5657a83bc: favicon('supabase.com'),
  '83bd276f02cec54cd90aab959098f086': pathToFileURL(resolve(output, 'agent-mark.svg')).href,
};
const connected = new Set(['Gmail', 'Google Calendar', 'Slack']);
const popular = [
  ['Gmail', 'a775741d035c096005f01126470cfa28'],
  ['Google Calendar', '4f19338f4855c96692808d7fc678d68b'],
  ['Slack', '2232e4031c798918112bf6f24ea37475'],
  ['Google Drive', 'b415ce011bb8efb11fb8d3c7476af19d'],
  ['Google Sheets', '122ab6e60ec4cc88b6b32ff067a5dcae'],
  ['Notion', 'ac0629639769052914326a5912440edb'],
  ['Linear', '5e28c9b37f716f7546dd4f76ed15b6ed'],
  ['HubSpot', 'aaf3e7a167a8fce5ee5cea5feb38f680'],
  ['Airtable', 'ef9708f14a359b123bf36e54804741f2'],
  ['Asana', '6cef0550a16d87dcd9f082ccf691308a'],
  ['Jira', 'e532748fb924f3c824d6e70ffa20bc08'],
  ['Supabase', 'f994a39fcd3a81c9ae18c5f5657a83bc'],
];

function popularRows() {
  return popular.map(([name, hash]) => `<div style="display: flex; align-items: center; gap: 14px; padding: 10px 0; border-bottom: 1px solid #E2D9CB"><div style="width: 34px; height: 34px; border-radius: 8px; background: #FBF8F2; display: flex; align-items: center; justify-content: center"><img src="${marks[hash]}" alt="" style="width: 19px; height: 19px"></div><div style="flex-grow: 1; font-size: 17px">${name}</div>${connected.has(name) ? '<div style="font-size: 14px; color: #6F6558">connected</div>' : '<a href="InRoom.html" style="min-height: 36px; padding: 0 14px; display: flex; align-items: center; border-radius: 9px; background: #1C1712; color: #F3EDE3; font-size: 14px; text-decoration: none">Connect</a>'}</div>`).join('');
}

for (const name of ['Main', 'Connect', 'InRoom', 'App']) {
  const sourceHtml = await readFile(resolve(source, `${name}.dc.html`), 'utf8');
  const helmet = sourceHtml.match(/<helmet>([\s\S]*?)<\/helmet>/)?.[1];
  let content = sourceHtml.match(/<\/helmet>([\s\S]*?)<\/x-dc>/)?.[1];
  if (!helmet || !content) throw new Error(`Board ${name} has unexpected markup`);
  if (name === 'Connect') content = content.replace(/<sc-for\b[\s\S]*?<\/sc-for>/, popularRows());
  content = content.replace(/\/_blob\/([a-f0-9]+)/g, (_, hash) => marks[hash] ?? favicon('beeline.work'));
  content = content.replaceAll('.dc.html', '.html');
  const html = `<!doctype html><html><head><meta charset="utf-8">${helmet}</head><body>${content}</body></html>`;
  await writeFile(resolve(output, `${name}.html`), html);
}
