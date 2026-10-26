// @ts-expect-error Executable production JSX inventory.
import { failureProofModule } from '../../scripts/error-surface-audit.mjs';
// @ts-expect-error Executable source-bound sweep proof builder.
import { changedSweepProofModule, writeEvidenceBoard } from '../../scripts/error-sweep-proof.mjs';
import changedManifest from '../../scripts/error-sweep-proof-cases.json';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
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
    shims['error-proof-changed-sweep']='export default [];';
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

it('screenshots every changed inventory row before and after in both themes and viewport classes', async () => {
  const mobile = process.cwd();
  const output = path.resolve('../..', '.beeline-proof/error-rows');
  mkdirSync(output, { recursive: true });
  expect(changedManifest.cases).toHaveLength(46);
  expect(new Set(changedManifest.cases.map(entry => entry.label)).size).toBe(46);
  const fonts = ['SpaceGrotesk-Regular','SpaceGrotesk-Medium','SpaceGrotesk-SemiBold'].map(font => `@font-face{font-family:'${font}';src:url(data:font/ttf;base64,${readFileSync(path.join(mobile,'sources/assets/fonts',font+'.ttf')).toString('base64')})}`).join('');
  const module = changedSweepProofModule(mobile);
  const captured: string[] = [];
  for (const theme of ['obsidian','bone']) for (const width of [828,1440]) {
    const shims = webProofShims(mobile);
    shims['react-native-unistyles'] = `import { ${theme}Theme } from '${path.join(mobile,'sources/theme')}';\n` + shims['react-native-unistyles']!.replace(/const theme = \{ buzz: beelineThemes\.obsidian \};/, `const theme = ${theme}Theme;`);
    shims['error-proof-production-rows'] = 'export default [];';
    shims['error-proof-inventory'] = 'export default [];';
    shims['error-proof-changed-sweep'] = module;
    for (let page=0;page<Math.ceil(changedManifest.cases.length/6);page++) {
      const entries = changedManifest.cases.slice(page*6,(page+1)*6);
      const proof = await runBrowserProof({entry:path.join(mobile,'scripts/failed-error-rows-proof.tsx'),mobile,shims,width,height:entries.length*400+32,query:`?changed&page=${page}`,head:`<style>${fonts}body{margin:0;background:${theme==='bone'?'#F3EEE4':'#14091A'}}#result{display:none}</style>`,screenshotPath:path.join(output,`changed-${theme}-${width}-page-${page+1}.png`)});
      expect(proof.status,proof.stderr).toBe(0);
      const result = JSON.parse(proof.result);
      expect(result.errors,`${theme} ${width} sweep page ${page+1}`).toEqual([]);
      expect(result.frames.map((frame: {id:string})=>frame.id)).toEqual(entries.flatMap(entry=>[`${entry.id}-before`,`${entry.id}-after`]));
      for (const frame of result.frames) {
        expect(frame.text.trim(),frame.id).not.toBe('');
        captured.push(`${theme}:${width}:${frame.id}`);
      }
    }
  }
  expect(captured).toHaveLength(changedManifest.cases.length*2*2*2);
  writeFileSync(path.join(output,'changed-coverage.json'),JSON.stringify({baselineCommit:changedManifest.baselineCommit,captured},null,2));
  writeEvidenceBoard(output);
},180_000);
