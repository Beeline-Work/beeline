import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';
it.skipIf(!existsSync(CHROME)).each(['bone', 'obsidian'] as const)(
  'CORNER-STATE: four states and Waiting taps (%s)',
  async (theme) => {
    const mobile = process.cwd();
    const dir = await mkdtemp(path.join(mobile, 'sources/buzz/corner-proof-'));
    const evidence = path.join(mobile, 'docs/evidence/corner-state');
    await mkdir(evidence, { recursive: true });
    try {
      const entry = path.join(dir, 'entry.tsx');
      await writeFile(
        entry,
        `import React from 'react';
import {createRoot} from 'react-dom/client';import {useUnistyles} from 'react-native-unistyles';
import {StateCircle} from '@/components/buzz/MonoHull';import {CornerHeaderAgentText} from '@/components/buzz/HeaderLadder';import {cornerDisplayState} from '@/buzz/corner-display-state';
const states=['working','review','waiting','idle'];const targets=['https://github.com/o/r/actions/runs/1','blocked-report','hold-message'];const tapped=[];
function Proof(){const {theme}=useUnistyles();document.body.style.background=theme.buzz.bgBase;
return <main style={{padding:24,color:theme.buzz.textPrimary,width:360}}>{states.map(state=>{const d=cornerDisplayState({state,lifecycle:{lifecycle:'working',checks:'unknown'}});return <div key={state} style={{display:'flex',alignItems:'center',gap:12,minHeight:44}}><StateCircle state={d.visual} tone={d.tone}/><CornerHeaderAgentText name="Jellybean" state={state} stateWord={state}/></div>})}{targets.map((target,index)=><div key={target} style={{display:'flex',alignItems:'center',gap:12,minHeight:44}}><StateCircle state="waiting" tone="brass"/><CornerHeaderAgentText name={['CI','Decision','Merge hold'][index]} state="waiting" stateWord="waiting" onReasonPress={()=>tapped.push(target)}/></div>)}</main>}
createRoot(document.getElementById('root')).render(<Proof/>);setTimeout(()=>{try{const links=[...document.querySelectorAll('[role="link"]')];if(links.length!==3)throw Error('Waiting links missing');for(const link of links){if(link.textContent!=='waiting')throw Error('reason leaked into label');link.click();}const glyphs=[...document.querySelectorAll('[aria-label]')].map(n=>n.getAttribute('aria-label')).filter(label=>['working','needs-you','waiting','idle'].includes(label)).slice(0,4);if(new Set(glyphs).size!==4)throw Error('state visuals collapsed: '+glyphs);document.getElementById('result').textContent=JSON.stringify({glyphs,tapped});}catch(error){document.getElementById('result').textContent='FAIL: '+error.message;}},300);`,
      );
      const shims = webProofShims(mobile);
      shims['react-native-unistyles'] = shims['react-native-unistyles']!.replace(
        'beelineThemes.obsidian',
        `beelineThemes.${theme}`,
      );
      const fonts = ['SpaceGrotesk-Regular', 'SpaceGrotesk-Medium', 'IBMPlexMono-Regular']
        .map(
          (name) =>
            `@font-face{font-family:'${name}';src:url(data:font/ttf;base64,${readFileSync(path.join(mobile, 'sources/assets/fonts', name + '.ttf')).toString('base64')})}`,
        )
        .join('');
      const result = await runBrowserProof({
        entry,
        mobile,
        shims,
        head: `<style>${fonts}#result{display:none}body{margin:0;overflow:hidden}</style>`,
        width: 420,
        height: 440,
        screenshotPath: path.join(evidence, `${theme}.png`),
      });
      expect(result.result).not.toContain('FAIL:');
      expect(JSON.parse(result.result)).toEqual({
        glyphs: ['working', 'needs-you', 'waiting', 'idle'],
        tapped: ['https://github.com/o/r/actions/runs/1', 'blocked-report', 'hold-message'],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  30000,
);
