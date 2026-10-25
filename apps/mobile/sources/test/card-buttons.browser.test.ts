import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { runBrowserProof } from './browserProof';
import { cardButtonShims } from '../../scripts/card-button-proof-shims';

it('R1/R2: card and tray share facts, boxed alternatives, labels and a local folded script', async () => {
  const mobile = process.cwd();
  const directory = await mkdtemp(path.join(mobile, 'sources/test/card-buttons-'));
  try {
    const entry = path.join(directory, 'proof.jsx');
    await writeFile(
      entry,
      `import React from 'react'; import { createRoot } from 'react-dom/client';
      import { CoreCardScenes } from '../../../scripts/card-button-fixtures';
      import { useUnistyles } from 'react-native-unistyles';
      function Proof({busy=false}){const {theme}=useUnistyles();document.body.style.background=theme.buzz.bgBase;
        return <div style={{width:new URLSearchParams(location.search).get('width')+'px',padding:16,boxSizing:'border-box',color:theme.buzz.textPrimary}}><CoreCardScenes busy={busy}/></div>}
      const root=createRoot(document.getElementById('root'));root.render(<Proof/>);
      const find=id=>document.querySelector('[data-testid="'+id+'"]');
      const box=node=>{const b=node.getBoundingClientRect();return {x:b.x,y:b.y,right:b.right,bottom:b.bottom}};
      setTimeout(async()=>{
        const pending=find('grant-request-pending');const tray=find('needs-you-tray-grant');
        const styles=id=>{const node=find(id),s=getComputedStyle(node);return {fill:s.backgroundColor,border:s.borderColor,width:s.borderTopWidth,box:box(node),text:node.textContent}};
        const result={pendingText:pending.textContent,trayText:tray.textContent, settled:find('grant-request-settled').textContent,
          card:['deny','once','always','source'].map(id=>styles('grant-grant-'+id)),
          tray:['2','0','1'].map(id=>styles('needs-you-action-tray-grant-'+id)),folded:!find('needs-you-script-tray-grant')};
        find('needs-you-script-tray-grant-toggle').click(); await new Promise(r=>setTimeout(r,60));
        result.opened=!!find('needs-you-script-tray-grant'); result.sourceOpened=!!globalThis.sourceOpened;
        find('needs-you-script-tray-grant-toggle').click();await new Promise(r=>setTimeout(r,60));
        find('needs-you-action-tray-grant-0').click();await new Promise(r=>setTimeout(r,60));
        result.busyLabel=find('needs-you-action-tray-grant-0').textContent;
        result.overflow=[...document.querySelectorAll('[role="button"],[role="link"]')].some(n=>box(n).right>Number(new URLSearchParams(location.search).get('width'))+1);
        root.render(<Proof busy/>);await new Promise(r=>setTimeout(r,60));result.cardBusyLabel=find('grant-grant-always').textContent;document.getElementById('result').textContent=JSON.stringify(result);
      },1000);`,
    );
    for (const theme of ['bone', 'obsidian'])
      for (const width of [360, 411, 960]) {
        const shims = cardButtonShims(mobile, theme);
        const out = process.env.BEELINE_DESIGN_PROOF_DIR;
        if (out) await mkdir(out, { recursive: true });
        const proof = await runBrowserProof({
          entry,
          mobile,
          shims,
          width: Math.max(520, width),
          height: 1800,
          query: `?width=${width}`,
          head: '<style>#result{display:none}</style>',
          ...(out ? { screenshotPath: path.join(out, `after-${theme}-${width}.png`) } : {}),
        });
        expect(proof.status, proof.stderr).toBe(0);
        const result = JSON.parse(proof.result);
        expect(result.pendingText).toContain('sudo -n python3 provision-ci-isolation.py');
        expect(result.trayText).toContain('sudo -n python3 provision-ci-isolation.py');
        expect(result.trayText).toContain('Establish isolated container support');
        expect(result.folded).toBe(true);
        expect(result.opened).toBe(true);
        expect(result.sourceOpened).toBe(false);
        expect(result.busyLabel).toContain('Once');
        expect(result.cardBusyLabel).toContain('Always');
        expect(result.overflow).toBe(false);
        expect(result.card[0].fill).toBe(result.card[1].fill);
        expect(result.card[0].fill).not.toBe(result.card[2].fill);
        expect(result.tray[0].fill).toBe(result.tray[1].fill);
        expect(result.tray[0].fill).not.toBe(result.tray[2].fill);
        expect(result.card[0].border).toBe(result.card[1].border);
        expect(result.card[3].box.x).toBeLessThanOrEqual(result.card[0].box.x);
        expect(result.card[3].box.y).toBeLessThanOrEqual(result.card[0].box.y);
        expect(result.settled).toContain('Once · Allowed by you');
      }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);
