import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { runBrowserProof, webProofShims } from './browserProof';

it('distinguishes workflow outcomes from tray dismissal in both themes', async () => {
  const mobile = process.cwd();
  const directory = await mkdtemp(path.join(mobile, 'sources/test/workflow-tray-'));
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
      const before = new URLSearchParams(location.search).get('before') === 'true';
      const actions = [
        {kind:'choice',choiceId:'gate',optionId:'A',label:'dispatch',detail:before?'go to dispatch':'Open a fix corner for each approved problem.'},
        {kind:'choice',choiceId:'gate',optionId:'B',label:'skip',detail:before?'go to done':'The sweep finished.'},
        ...(before?[{kind:'skip-choice',choiceId:'gate',label:'Skip'}]:[]),
      ];
      const item = {messageId:'gate',workspaceId:'w',roomId:'r',roomName:'Tubing Crew',roomKind:'room',
        text:before?'feedback-triage: approve':'A person approves dispatching the ranked problems, or skips them.',createdAt:Math.floor(Date.now()/1000),
        approval:{kind:'choice',actor:'Ruby',ask:'asks you to choose',literal:false,
          subject:before?'feedback-triage: approve':'A person approves dispatching the ranked problems, or skips them.',
          actions}};
      const calls = [];
      function Proof(){
        const { theme }=useUnistyles(); document.body.style.background=theme.buzz.bgTerminal;
        return <NeedsYouCell item={item} now={Date.now()}
        desktop={true} onOpen={()=>{}} onDismiss={()=>calls.push('dismiss')}
        onAction={async (_item, action)=>calls.push(action)}/>;
      }
      createRoot(document.getElementById('root')).render(<Proof/>);
      setTimeout(async()=>{
        const labels = [...document.querySelectorAll('[data-testid^="needs-you-action-"]')].map(node=>node.textContent);
        for (let index=0;index<actions.length;index++) {
          document.querySelector('[data-testid="needs-you-action-gate-'+index+'"]').click();
          await new Promise(resolve=>setTimeout(resolve,30));
        }
        document.querySelector('[data-testid="needs-you-gate"]').dispatchEvent(new PointerEvent('pointerenter',{pointerType:'mouse'}));
        await new Promise(resolve=>setTimeout(resolve,30));
        const dismiss=document.querySelector('[data-testid="needs-you-dismiss-gate"]');
        if(dismiss) dismiss.click();
        document.getElementById('result').textContent=JSON.stringify({dismiss:!!dismiss,labels,calls,text:document.getElementById('root').textContent,
          overflow:document.documentElement.scrollWidth>innerWidth});
      },1000);`);
    for (const theme of ['obsidian', 'bone']) {
      for (const before of [true, false]) {
        const shims = webProofShims(mobile);
        shims['react-native-unistyles'] = shims['react-native-unistyles']!.replace('beelineThemes.obsidian', `beelineThemes.${theme}`);
        shims['@/auth/monolith-session'] = 'export const monolithSession = {}; export const MONOLITH_REQUEST_TIMEOUT_MS = 15000;';
        shims['react-native-gesture-handler'] = 'export const Swipeable = props => props.children;';
        const proof = await runBrowserProof({ entry, mobile, width: 390, height: 700, shims,
          query: `?before=${before}`,
          ...(process.env.BEELINE_DESIGN_PROOF_DIR ? { screenshotPath: path.join(process.env.BEELINE_DESIGN_PROOF_DIR, `workflow-tray-${before ? 'before' : 'after'}-${theme}.png`) } : {}),
        });
        expect(proof.status, proof.stderr).toBe(0);
        const result = JSON.parse(proof.result);
        expect(result.labels).toHaveLength(before ? 3 : 2);
        expect(result.dismiss).toBe(true);
        expect(result.calls.at(-1)).toBe('dismiss');
        expect(result.calls.slice(0,-1).map((action: { kind: string; optionId?: string }) => [action.kind, action.optionId])).toEqual(
          before ? [['choice', 'A'], ['choice', 'B'], ['skip-choice', undefined]] : [['choice', 'A'], ['choice', 'B']],
        );
        expect(result.text).toContain(before ? 'feedback-triage: approve' : 'Open a fix corner for each approved problem.');
        expect(result.overflow).toBe(false);
        console.log(`Reproduction tray-choice-clarity ${before ? 'before' : 'after'} ${theme}: ${JSON.stringify(result)}`);
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 120_000);
