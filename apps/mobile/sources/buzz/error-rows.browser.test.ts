// @ts-expect-error Executable production JSX inventory.
import { failureProofModule } from '../../scripts/error-surface-audit.mjs';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { runBrowserProof, webProofShims } from '@/test/browserProof';

it('reproduces R1 and demonstrates the failed row with a single retry per row or word tap', async () => {
  const mobile=process.cwd();
  const output=path.resolve('../..', '.beeline-proof/error-rows');
  mkdirSync(output,{recursive:true});
  const fonts = ['SpaceGrotesk-Regular','SpaceGrotesk-Medium','SpaceGrotesk-SemiBold'].map(font => `@font-face{font-family:'${font}';src:url(data:font/ttf;base64,${readFileSync(path.join(mobile,'sources/assets/fonts',font+'.ttf')).toString('base64')})}`).join('');
  for (const theme of ['obsidian','bone']) for (const width of [780,1440]) {
    const shims=webProofShims(mobile);
    shims['react-native-unistyles']=shims['react-native-unistyles']!.replace('beelineThemes.obsidian',`beelineThemes.${theme}`);
    shims['error-proof-production-rows']=failureProofModule(path.join(mobile,'sources'));
    shims['error-proof-inventory']=`export default ${readFileSync(path.join(mobile,'design/error-surface-allowlist.json'),'utf8')};`;
    const result=await runBrowserProof({entry:path.join(mobile,'scripts/failed-error-rows-proof.tsx'),mobile,shims,width,height:1900,head:`<style>${fonts}body{margin:0;background:${theme==='bone'?'#F3EEE4':'#14091A'}}#result{display:none}</style>`,screenshotPath:path.join(output,`${theme}-${width}.png`)});
    expect(result.status,result.stderr).toBe(0);
    const state=JSON.parse(result.result);
    expect(state.retries).toBe(2);
    expect(state.left).toBeGreaterThan(20);
    expect(state.title).toContain('Couldn’t reach Beeline');
    expect(state.title).not.toContain('RoomViewHttpError');
    const sweep = await runBrowserProof({entry:path.join(mobile,'scripts/failed-error-rows-proof.tsx'),mobile,shims,width,height:12000,query:'?sweep',head:`<style>${fonts}body{margin:0;background:${theme==='bone'?'#F3EEE4':'#14091A'}}#result{display:none}</style>`,screenshotPath:path.join(output,`sweep-${theme}-${width}.png`)});
    expect(sweep.status,sweep.stderr).toBe(0);
    expect(sweep.result).toBe('sweep rendered');
  }
},120_000);
