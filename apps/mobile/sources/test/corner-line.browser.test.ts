import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { runBrowserProof, webProofShims } from './browserProof';

it('draws the call-site corner line in the Room corner row format in both themes', async () => {
  const mobile = process.cwd();
  const directory = await mkdtemp(path.join(mobile, 'sources/test/corner-line-proof-'));
  try {
    const entry = path.join(directory, 'proof.tsx');
    await writeFile(
      entry,
      `import React from 'react';
import { createRoot } from 'react-dom/client';
import { CornerOpenedMarker } from '@/components/buzz/CornerOpenedMarker';
import { NotificationLifecycleCard } from '@/components/buzz/PrLifecycleCard';
import { foldPrLifecycleRuns } from '@/buzz/pr-lifecycle';
import { useUnistyles } from 'react-native-unistyles';
import regular from '@/assets/fonts/SpaceGrotesk-Regular.ttf';
import strong from '@/assets/fonts/SpaceGrotesk-SemiBold.ttf';
import medium from '@/assets/fonts/SpaceGrotesk-Medium.ttf';
import mono from '@/assets/fonts/IBMPlexMono-Regular.ttf';
const fonts = document.createElement('style');
fonts.textContent = [[regular,'SpaceGrotesk-Regular'],[strong,'SpaceGrotesk-SemiBold'],[medium,'SpaceGrotesk-Medium'],[mono,'IBMPlexMono-Regular']].map(([url,name])=>'@font-face{font-family:'+name+';src:url('+url+')}').join('') + '#result{display:none}';
document.head.appendChild(fonts);
let destination = '';
const base = { text: '', timestamp: 1, isUser: false };
const opened = { ...base, id: 'opened', daemonFact: { type: 'corner-open', cornerId: 'corner-font-check', name: 'font-check-android', objective: 'Check fonts', sourceMessageId: 'dm-source' } };
const pr = { ...base, id: 'pr', daemonFact: { type: 'corner-complete', outcome: 'landed', cornerId: 'corner-2742', objective: 'Keep agent lead and body text in the same font face', pullRequest: { number: 2742, title: 'Keep agent lead and body text in the same font face', url: 'https://github.com/Beeline-Work/beeline/pull/2742' } } };
const props = { onOpenCorner: id => destination = 'corner:' + id, onOpenUrl: url => destination = url };
const card = messages => foldPrLifecycleRuns(messages).map(message => <NotificationLifecycleCard key={message.id} message={message} {...props}/>);
function Proof() {
  const { theme } = useUnistyles();
  document.body.style.background = theme.buzz.bgBase;
  document.body.style.color = theme.buzz.textPrimary;
  // DOM line-height needs px; a bare number would multiply the font size.
  const dom = type => ({ ...type, lineHeight: type.lineHeight + 'px' });
  const body = { ...dom(theme.buzz.type.body), color: theme.buzz.textPrimary, margin: 0 };
  const label = { ...dom(theme.buzz.type.meta), color: theme.buzz.ledgerQuiet, margin: '24px 0 8px' };
  return <main style={{padding:24,maxWidth:760,fontFamily:'SpaceGrotesk-Regular'}}>
    <p style={label}>LOCAL BUILD · corner line · {theme.buzz.dark ? 'Obsidian' : 'Bone'} · desktop column</p>
    <section data-surface="room">
      <p style={label}>#beeline</p>
      <p style={body}>@ruby open a corner to align the corner lines.</p>
      <div data-line="call-site"><CornerOpenedMarker title="latency-rig" onOpen={() => destination = 'corner:corner-latency-rig'}/></div>
      <div data-line="room">{card([opened])}</div>
      {card([pr])}
      <p style={{...body, marginTop:24}}>@ruby open a corner with a long name.</p>
      <div data-line="long"><CornerOpenedMarker title="call-site-corner-line-shares-the-room-row-format-and-truncates-before-the-chevron" onOpen={() => destination = 'corner:long'}/></div>
    </section>
    <section data-surface="dm">
      <p style={label}>DM with Ruby</p>
      <p style={body}>Check fonts on Android as play-review.</p>
      <div data-line="dm"><CornerOpenedMarker title="font-check-android" onOpen={() => destination = 'corner:corner-font-check'}/></div>
    </section>
  </main>;
}
const assert = (ok, text) => { if (!ok) throw Error(text); };
const runs = line => [...line.querySelectorAll('[dir="auto"], span, div')].filter(node => node.childNodes.length && [...node.childNodes].some(child => child.nodeType === 3 && child.textContent.trim()));
const format = line => runs(line).map(node => { const s = getComputedStyle(node); return [node.textContent, s.fontFamily, s.fontSize, s.lineHeight, s.fontWeight, s.color].join(' | '); });
async function main() {
  await Promise.all(['SpaceGrotesk-Regular','SpaceGrotesk-SemiBold','SpaceGrotesk-Medium','IBMPlexMono-Regular'].map(name=>document.fonts.load('16px '+name)));
  createRoot(document.getElementById('root')).render(<Proof/>);
  await new Promise(resolve=>setTimeout(resolve,200));
  const line = name => document.querySelector('[data-line="' + name + '"]');
  const callSite = format(line('call-site')).map(row => row.replace('latency-rig', 'NAME'));
  const room = format(line('room')).map(row => row.replace('font-check-android', 'NAME'));
  assert(callSite.length > 0 && JSON.stringify(callSite) === JSON.stringify(room), 'format differs: ' + JSON.stringify({callSite, room}));
  assert(line('call-site').textContent === 'Opened latency-rig', 'call-site words: ' + line('call-site').textContent);
  assert(line('room').textContent === 'Opened font-check-android', 'room words: ' + line('room').textContent);
  for (const name of ['call-site', 'dm', 'long']) assert(line(name).querySelectorAll('svg').length === 2, name + ': glyph and chevron');
  assert(line('room').querySelectorAll('svg').length === 2, 'room: branch and chevron');
  const long = line('long');
  const [, chevron] = long.querySelectorAll('svg');
  assert(chevron.getBoundingClientRect().right <= long.getBoundingClientRect().right, 'long name pushes the chevron out');
  const results = {};
  for (const [name, expected] of [['call-site','corner:corner-latency-rig'],['dm','corner:corner-font-check'],['long','corner:long'],['room','corner:corner-font-check']]) {
    destination = '';
    line(name).querySelector('[role="link"]').click();
    assert(destination === expected, name + ': destination ' + destination);
    results[name] = destination;
  }
  document.getElementById('result').textContent = JSON.stringify({source:'local built production components', format: callSite, destinations: results});
}
main().catch(error=>document.getElementById('result').textContent = 'FAIL: '+error.message);`,
    );
    for (const theme of ['bone', 'obsidian']) {
      const shims = webProofShims(mobile);
      shims['react-native-unistyles'] = shims['react-native-unistyles']!.replace(
        'beelineThemes.obsidian',
        `beelineThemes.${theme}`,
      );
      shims['expo-router'] =
        'export const router = {}; export const useRouter = () => ({}); export const useLocalSearchParams = () => ({});';
      shims['./HullActionSheet'] =
        'export const HullActionSheetModal = () => null; export const HullActionSheetRow = () => null; export const HULL_SHEET_INSET = 22;';
      const output = process.env.CORNER_LINE_PROOF_OUT;
      if (output) await mkdir(output, { recursive: true });
      const proof = await runBrowserProof({
        entry,
        mobile,
        shims,
        width: 820,
        height: 760,
        ...(output ? { screenshotPath: path.resolve(output, `desktop-${theme}.png`) } : {}),
      });
      expect(proof.status, proof.stderr).toBe(0);
      expect(proof.result).not.toMatch(/^FAIL:/);
      const result = JSON.parse(proof.result);
      if (output)
        await writeFile(
          path.join(output, `desktop-${theme}-results.json`),
          JSON.stringify(result, null, 2) + '\n',
        );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
