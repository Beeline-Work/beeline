import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { runBrowserProof, webProofShims } from './browserProof';

type Plate = { left: number; width: number; top: number; background: string; busy: string | null };
type Cell = {
  plates: Plate[];
  detail: boolean;
  consequenceLefts: number[];
  labelLefts: number[];
  skip: { top: number; background: string } | null;
  overflow: boolean;
};

// Reproduction tray-choice-1: the reported workflow gate (retry/stop) and an
// open four-option question with Skip, on a phone and on a desktop width.
it('shows Tray choice options as equal, aligned plates without the duplicate option line', async () => {
  const mobile = process.cwd();
  const directory = await mkdtemp(path.join(mobile, 'sources/test/tray-choice-plates-'));
  try {
    const entry = path.join(directory, 'proof.jsx');
    await writeFile(entry, `import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { NeedsYouCell } from '@/components/buzz/NeedsYouCell';
      import { useUnistyles } from 'react-native-unistyles';
      import regularFont from '@/assets/fonts/SpaceGrotesk-Regular.ttf';
      import mediumFont from '@/assets/fonts/SpaceGrotesk-Medium.ttf';
      import semiboldFont from '@/assets/fonts/SpaceGrotesk-SemiBold.ttf';
      const style=document.createElement('style');
      style.textContent=[['SpaceGrotesk-Regular',regularFont],['SpaceGrotesk-Medium',mediumFont],['SpaceGrotesk-SemiBold',semiboldFont]]
        .map(([name,url])=>'@font-face{font-family:'+name+';src:url('+url+')}').join('')+'#result{display:none}';
      document.head.appendChild(style);
      const desktop = new URLSearchParams(location.search).get('desktop') === 'true';
      const now = Math.floor(Date.now()/1000);
      const choice = (choiceId, optionId, label, detail) => ({kind:'choice',choiceId,optionId,label,detail});
      const gate = {messageId:'gate',workspaceId:'w',roomId:'r',roomName:'mm-desk',parentRoomName:'experiments',roomKind:'corner',
        text:'The build failed twice. Retry it, or stop the run.',createdAt:now-120,
        approval:{kind:'choice',actor:'Sol',ask:'asks you to choose',literal:false,detail:'retry · stop',
          actions:[choice('gate','A','retry','Run the failed build step again with the same inputs and report the result.'),
            choice('gate','B','stop','End the run.')]}};
      const question = {messageId:'question',workspaceId:'w',roomId:'r2',roomName:'Tubing Crew',roomKind:'room',
        text:'Which release window should the Android build ship in?',createdAt:now-3600,expiresAt:now+7200,
        approval:{kind:'choice',actor:'Ruby',ask:'asks you to choose',literal:false,detail:'tonight · tomorrow · friday · hold',
          actions:[choice('question','A','tonight','Ship at 2 AM Eastern with the nightly release once checks pass on main.'),
            choice('question','B','tomorrow','Ship tomorrow afternoon.'),
            choice('question','C','friday','Wait for the Friday batch so it lands with the settings work and the voice fixes.'),
            choice('question','D','hold','Do not ship.'),
            {kind:'skip-choice',choiceId:'question',label:'Skip'}]}};
      let release;
      function Proof(){
        const { theme }=useUnistyles(); document.body.style.background=theme.buzz.bgTerminal;
        window.primaryFill=theme.buzz.buttonPrimaryFill;
        return <div style={{display:'flex',flexDirection:'column',width:desktop?'100%':393}}>{[gate,question].map(item=>
          <NeedsYouCell key={item.messageId} item={item} now={Date.now()} desktop={desktop}
            onOpen={()=>{}} onDismiss={()=>{}}
            onAction={()=>new Promise(resolve=>{release=resolve;})}/>)}</div>;
      }
      createRoot(document.getElementById('root')).render(<Proof/>);
      const rgb = color => { const node=document.createElement('div'); node.style.color=color; document.body.appendChild(node);
        const value=getComputedStyle(node).color; node.remove(); return value; };
      const cell = id => {
        const nodes=[...document.querySelectorAll('[data-testid^="needs-you-action-'+id+'-"]')];
        const box = node => node.getBoundingClientRect();
        const options=nodes.filter(node=>!/^Skip$/.test(node.textContent));
        const skip=nodes.find(node=>/^Skip$/.test(node.textContent));
        const textLeft = (node, index) => { const texts=[...node.querySelectorAll('div[dir="auto"]')].filter(text=>text.textContent.length>1);
          return texts[index] ? Math.round(box(texts[index]).left) : null; };
        return {
          plates: options.map(node=>({left:Math.round(box(node).left),width:Math.round(box(node).width),top:Math.round(box(node).top),
            background:getComputedStyle(node).backgroundColor,busy:node.getAttribute('aria-busy')})),
          detail: !!document.querySelector('[data-testid="needs-you-detail-'+id+'"]'),
          labelLefts: options.map(node=>textLeft(node,0)),
          consequenceLefts: options.map(node=>textLeft(node,1)),
          skip: skip ? {top:Math.round(box(skip).top),background:getComputedStyle(skip).backgroundColor} : null,
          overflow: options.some(node=>node.scrollWidth>node.clientWidth+1),
        };
      };
      setTimeout(async()=>{
        const idle={gate:cell('gate'),question:cell('question')};
        document.querySelector('[data-testid="needs-you-action-question-2"]').click();
        await new Promise(resolve=>setTimeout(resolve,60));
        const busy=cell('question');
        release?.();
        document.getElementById('result').textContent=JSON.stringify({primary:rgb(window.primaryFill),idle,busy,
          pageOverflow:document.documentElement.scrollWidth>innerWidth});
      },1000);`);
    for (const theme of ['obsidian', 'bone']) {
      for (const desktop of [false, true]) {
        const shims = webProofShims(mobile);
        shims['react-native-unistyles'] = shims['react-native-unistyles']!.replace('beelineThemes.obsidian', `beelineThemes.${theme}`);
        shims['@/auth/monolith-session'] = 'export const monolithSession = {}; export const MONOLITH_REQUEST_TIMEOUT_MS = 15000;';
        shims['react-native-gesture-handler'] = 'export const Swipeable = props => props.children;';
        const proof = await runBrowserProof({ entry, mobile, width: desktop ? 720 : 520, height: desktop ? 900 : 851, shims,
          query: `?desktop=${desktop}`,
          ...(process.env.BEELINE_DESIGN_PROOF_DIR ? { screenshotPath: path.join(process.env.BEELINE_DESIGN_PROOF_DIR, `tray-choice-${desktop ? 'desktop' : 'android'}-${theme}.png`) } : {}),
        });
        expect(proof.status, proof.stderr).toBe(0);
        const result = JSON.parse(proof.result) as { primary: string; idle: Record<'gate' | 'question', Cell>; busy: Cell; pageOverflow: boolean };
        console.log(`Reproduction tray-choice-1 ${desktop ? 'desktop' : 'android'} ${theme}: ${JSON.stringify(result)}`);
        for (const [id, cell] of Object.entries(result.idle)) {
          expect(cell.plates, id).toHaveLength(id === 'gate' ? 2 : 4);
          expect(new Set(cell.plates.map((plate) => plate.width)).size, `${id} widths`).toBe(1);
          expect(new Set(cell.plates.map((plate) => plate.left)).size, `${id} left edges`).toBe(1);
          expect(cell.plates.every((plate) => plate.background !== result.primary), `${id} primary`).toBe(true);
          expect(new Set(cell.labelLefts).size, `${id} label lefts`).toBe(1);
          expect(cell.consequenceLefts, `${id} consequence lefts`).toEqual(cell.labelLefts);
          expect(cell.detail, `${id} duplicate option line`).toBe(false);
          expect(cell.overflow, `${id} overflow`).toBe(false);
        }
        expect(result.idle.gate.skip).toBeNull();
        expect(result.idle.question.skip).not.toBeNull();
        expect(result.idle.question.skip!.top).toBeGreaterThan(result.idle.question.plates.at(-1)!.top);
        expect(result.idle.question.skip!.background).not.toBe(result.primary);
        expect(result.busy.plates.map((plate) => plate.busy === 'true')).toEqual([false, false, true, false]);
        expect(result.pageOverflow).toBe(false);
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 180_000);
