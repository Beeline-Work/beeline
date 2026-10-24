import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { runBrowserProof, webProofShims } from './browserProof';

it.skipIf(!process.env.CORNER_ROOM_PROOF_INPUT)('Reproduction CORNER-ROOM-2: service-projected Room openings and PR destinations in both themes', async () => {
  const mobile = process.cwd();
  const snapshots = JSON.parse(await readFile(process.env.CORNER_ROOM_PROOF_INPUT!, 'utf8'));
  const directory = await mkdtemp(path.join(mobile, 'sources/test/corner-room-proof-'));
  try {
    const entry = path.join(directory, 'proof.tsx');
    await writeFile(entry, `import React from 'react';
import { createRoot } from 'react-dom/client';
import { NotificationLifecycleCard } from '@/components/buzz/PrLifecycleCard';
import { displayRoomMessage } from '@/buzz/room-view-presentation';
import { foldPrLifecycleRuns } from '@/buzz/pr-lifecycle';
import { useUnistyles } from 'react-native-unistyles';
import regular from '@/assets/fonts/SpaceGrotesk-Regular.ttf';
import medium from '@/assets/fonts/SpaceGrotesk-Medium.ttf';
import strong from '@/assets/fonts/SpaceGrotesk-SemiBold.ttf';
import mono from '@/assets/fonts/IBMPlexMono-Regular.ttf';
const snapshots = ${JSON.stringify(snapshots)};
const fonts = document.createElement('style');
fonts.textContent = [[regular,'SpaceGrotesk-Regular'],[strong,'SpaceGrotesk-SemiBold'],[medium,'SpaceGrotesk-Medium'],[mono,'IBMPlexMono-Regular']].map(([url,name])=>'@font-face{font-family:'+name+';src:url('+url+')}').join('') + '#result{display:none}';
document.head.appendChild(fonts);
let destination = '';
const frames = ['opened','merged','closed'];
const props = { onOpenCorner: id => destination = id, onOpenUrl: url => destination = url };
function Proof() {
 const { theme } = useUnistyles();
 document.body.style.background = theme.buzz.bgBase;
 document.body.style.color = theme.buzz.textPrimary;
 return <main style={{padding:24,maxWidth:760,fontFamily:'SpaceGrotesk-Regular'}}>
  <p>LOCAL BUILD · actual service responses · {theme.buzz.dark ? 'Obsidian' : 'Bone'}</p>
  {frames.map(frame => <section key={frame} data-frame={frame}>
   <h2 style={{fontSize:15,fontWeight:500}}>Room after corner {frame}</h2>
   {foldPrLifecycleRuns(snapshots['dm-'+frame].roomMessages.map(m => displayRoomMessage(m, 'c'.repeat(64)))).map(message => message.notificationLifecycleRun
    ? <NotificationLifecycleCard key={message.id} message={message} {...props}/>
    : <p key={message.id}>{message.text}</p>)}
  </section>)}
 </main>;
}
const assert = (ok, message) => { if(!ok) throw Error(message); };
async function main() {
 await Promise.all(['SpaceGrotesk-Regular','SpaceGrotesk-Medium','SpaceGrotesk-SemiBold','IBMPlexMono-Regular'].map(name=>document.fonts.load('16px '+name)));
 createRoot(document.getElementById('root')).render(<Proof/>);
 await new Promise(resolve=>setTimeout(resolve,250));
 const results = [];
 for(const frame of frames) {
  const section = document.querySelector('[data-frame="'+frame+'"]');
  // Multiple repository events share the production disclosure; open it.
  for(const header of section.querySelectorAll('[data-testid^="notification-run-expand-"]')) header.click();
  await new Promise(resolve=>setTimeout(resolve,100));
  const messages = snapshots['dm-'+frame].roomMessages;
  const opening = messages.find(m=>m.daemonFact?.type==='corner-open');
  assert(opening,'opening is missing');
  const row = section.querySelector('[data-testid="notification-run-cell-'+opening.id+'"]');
  assert(row?.textContent==='Opened requested-work','opening changed: '+row?.textContent);
  assert(!messages.some(m=>m.daemonFact?.type==='corner-complete'),'corner completion leaked into Room');
  const pr = messages.find(m=>m.githubEvent?.type==='pull-request');
  if(pr) {
   destination = '';
   section.querySelector('[data-testid="notification-run-cell-url-'+pr.id+'"]').click();
   assert(destination===pr.githubEvent.cornerId,'PR row did not open corner');
   results.push({frame,prDestination:destination});
  }
  results.push({frame,openingId:opening.id,text:row.textContent});
 }
 assert(document.documentElement.scrollWidth<=innerWidth,'horizontal overflow');
 document.getElementById('result').textContent=JSON.stringify({source:'actual isolated phone service and webhook responses',results});
}
main().catch(error=>document.getElementById('result').textContent='FAIL: '+error.message);`);
    for (const theme of ['bone', 'obsidian']) {
      const shims = webProofShims(mobile);
      shims['react-native-unistyles'] = shims['react-native-unistyles']!.replace('beelineThemes.obsidian', `beelineThemes.${theme}`);
      shims['expo-router'] = 'export const router = {}; export const useRouter = () => ({}); export const useLocalSearchParams = () => ({});';
      shims['./HullActionSheet'] = 'export const HullActionSheetModal = () => null; export const HullActionSheetRow = () => null; export const HULL_SHEET_INSET = 22;';
      const output = process.env.CORNER_ROOM_PROOF_OUT;
      if (output) await mkdir(output, { recursive: true });
      const proof = await runBrowserProof({ entry, mobile, shims, width: 820, height: 1000,
        ...(output ? { screenshotPath: path.join(output, `room-pr-${theme}.png`) } : {}),
      });
      expect(proof.status, proof.stderr).toBe(0);
      expect(proof.result).not.toMatch(/^FAIL:/);
      const result = JSON.parse(proof.result);
      expect(result.results).toHaveLength(5);
      if (output) await writeFile(path.join(output, `room-pr-${theme}.json`), JSON.stringify(result, null, 2));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 120_000);
