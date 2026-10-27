import { mkdtemp, writeFile, rm, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import sharp from 'sharp';
import { runBrowserProof, webProofShims } from './browserProof';
it.each(['clients', 'sheet', 'message', 'disconnect', 'failure'])('renders connector %s with production controls', async frame => {
  const mobile = process.cwd();
  const dir = await mkdtemp(path.join(mobile, 'sources/test/mcp-proof-'));
  const evidence = path.join(mobile, 'evidence/rooms-mcp');
  await mkdir(evidence, { recursive: true });
  const logos = await Promise.all(['grok', 'muse'].map(async name => 'data:image/png;base64,' +
    (await sharp(await readFile(path.join(mobile, '../server/assets/mcp', name + '.svg'))).resize(96, 96).png().toBuffer()).toString('base64')));
  const clients = ['Grok', 'Meta Muse'].map((name, index) => ({ clientId: 'client-' + index, name, scopes: index ? ['rooms:read'] : ['rooms:read', 'rooms:write'], connectedAt: 1793055600, lastUsedAt: 1793056200, logo: logos[index] }));
  try {
    const entry = path.join(dir, 'proof.jsx');
    await writeFile(entry, `import React from 'react'; import { createRoot } from 'react-dom/client';
      import { AiClientsSection } from '@/components/buzz/AiClientsSection';
      import { LedgerSteer } from '@/components/buzz/Ledger';
      import { PageHeader } from '@/components/buzz/PageHeader';
      const frame=${JSON.stringify(frame)}; const clients=${JSON.stringify(clients)};
      createRoot(document.getElementById('root')).render(<div style={{minHeight:'100vh',background:'#F3EEE4'}}>
        <PageHeader prominent eyebrow={frame === 'message' ? undefined : 'Settings'} title={frame === 'message' ? '#connector-demo' : 'Connectors'} />
        <div style={{padding:24}}>{frame === 'message' ? <LedgerSteer itemId="message" bodyText="@demo-agent acknowledge the connector review" bodyTestID="message" chronological byline={{name:'Connector Reviewer',stamp:'20:43',isViewer:true,sourceClient:{id:'client-0',name:'Grok'}}} /> :
          <AiClientsSection clients={clients} onChanged={() => {globalThis.changed=true;}} />}</div></div>);
      setTimeout(()=>{
        if(['sheet','disconnect','failure'].includes(frame)) document.querySelector('[data-testid="ai-client-client-0"]').click();
        setTimeout(async()=>{
          if(['disconnect','failure'].includes(frame)) {
            globalThis.failDisconnect=frame==='failure';
            document.querySelector('[data-testid="ai-client-disconnect"]').click();
            await new Promise(resolve=>setTimeout(resolve,200));
          }
          document.getElementById('result').textContent=JSON.stringify({text:document.body.textContent,images:document.querySelectorAll('img').length,operation:globalThis.operation,changed:globalThis.changed});
        },500);
      },500);`);
    const shims = webProofShims(mobile);
    shims['react-native-unistyles'] = shims['react-native-unistyles'].replace('beelineThemes.obsidian', 'beelineThemes.bone');
    shims['@/sync/transport/monolith-operation'] = 'export const monolithPhoneOperation = async (name,input) => {globalThis.operation={name,input};if(globalThis.failDisconnect)throw new Error("Network unavailable");};';
    shims['expo-router'] = 'export const router={back(){},push(){}};';
    const fonts = (await Promise.all(['SpaceGrotesk-Regular','SpaceGrotesk-Medium','SpaceGrotesk-SemiBold','IBMPlexMono-Regular'].map(async name =>
      `@font-face{font-family:${name};src:url(data:font/ttf;base64,${(await readFile(path.join(mobile,'sources/assets/fonts',name+'.ttf'))).toString('base64')})}`))).join('');
    const result = await runBrowserProof({ entry, mobile, shims, width: 430, height: 932,
      screenshotPath: path.join(evidence, 'web-' + frame + '.png'),
      head: `<style>${fonts}#result{display:none}</style>` });
    expect(result.status, result.stderr).toBe(0);
    const shown = JSON.parse(result.result);
    expect(shown.text).toContain(frame === 'message' ? 'via Grok' : frame === 'sheet' ? 'Disconnect Grok?' : 'AI CLIENTS');
    if(['disconnect','failure'].includes(frame)) {
      expect(shown.operation).toEqual({name:'disconnectAiClient',input:{clientId:'client-0'}});
      if(frame==='disconnect') { expect(shown.changed).toBe(true); expect(shown.text).not.toContain('Disconnect Grok?'); }
      else { expect(shown.changed).not.toBe(true); expect(shown.text).toContain('Could not disconnect this client. Try again.'); }
    }
    if(frame !== 'message') { expect(shown.text).toContain('Meta Muse'); expect(shown.images).toBeGreaterThanOrEqual(2); }
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 90_000);
