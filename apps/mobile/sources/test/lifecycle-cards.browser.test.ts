import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { runBrowserProof, webProofShims } from './browserProof';

it('Reproduction lifecycle-cards-2: local web renders every inventory variant with shared actions', async () => {
  const mobile = process.cwd();
  const directory = await mkdtemp(path.join(mobile, 'sources/test/lifecycle-proof-'));
  try {
    const entry = path.join(directory, 'proof.tsx');
    await writeFile(entry, `import React from 'react';
import { createRoot } from 'react-dom/client';
import { DaemonFactCard, GitHubEventCard } from '@/components/buzz/LifecycleCard';
import { NotificationLifecycleCard } from '@/components/buzz/PrLifecycleCard';
import { lifecycleFixtures } from '../../../scripts/lifecycle-card-fixtures';
import { useUnistyles } from 'react-native-unistyles';
import regular from '@/assets/fonts/SpaceGrotesk-Regular.ttf';
import strong from '@/assets/fonts/SpaceGrotesk-SemiBold.ttf';
import medium from '@/assets/fonts/SpaceGrotesk-Medium.ttf';
import mono from '@/assets/fonts/IBMPlexMono-Regular.ttf';
const fonts = document.createElement('style');
fonts.textContent = [[regular,'SpaceGrotesk-Regular'],[strong,'SpaceGrotesk-SemiBold'],[medium,'SpaceGrotesk-Medium'],[mono,'IBMPlexMono-Regular']].map(([url,name])=>'@font-face{font-family:'+name+';src:url('+url+')}').join('') + '#result{display:none}';
document.head.appendChild(fonts);
let destination = '';
const props = { onOpenCorner: id => destination = 'corner:' + id, onOpenUrl: url => destination = url };
function Proof() {
  const { theme } = useUnistyles();
  document.body.style.background = theme.buzz.bgBase;
  document.body.style.color = theme.buzz.textPrimary;
  return <main style={{padding:24,fontFamily:'SpaceGrotesk-Regular'}}>
    <h1>LOCAL BUILD · lifecycle cards · {theme.buzz.dark ? 'Obsidian' : 'Bone'}</h1>
    <p>Production components with deterministic fixture data. This page is not web.usebeeline.app.</p>
    <div style={{display:'grid',gridTemplateColumns:'repeat(3,minmax(0,1fr))',gap:24}}>
    {lifecycleFixtures.map(f => <section key={f.name} data-variant={f.name} style={{border:'1px solid '+theme.buzz.border,padding:16,minWidth:0}}>
      <h2 style={{fontSize:13}}>{f.name}</h2>
      {f.message.notificationLifecycleRun ? <NotificationLifecycleCard message={f.message} {...props}/> : f.message.githubEvent ? <GitHubEventCard message={f.message} onOpenUrl={props.onOpenUrl}/> : <DaemonFactCard message={f.message} {...props}/>}
    </section>)}
    </div>
  </main>;
}
const assert = (ok, text) => { if (!ok) throw Error(text); };
async function main() {
  await Promise.all(['SpaceGrotesk-Regular','SpaceGrotesk-SemiBold','SpaceGrotesk-Medium','IBMPlexMono-Regular'].map(name=>document.fonts.load('16px '+name)));
  createRoot(document.getElementById('root')).render(<Proof/>);
  await new Promise(resolve=>setTimeout(resolve,200));
  const expanded = document.querySelector('[data-variant="grouped-expanded"]');
  expanded.querySelector('[data-testid^="notification-run-expand-"]').click();
  await new Promise(resolve=>setTimeout(resolve,100));
  const results = [];
  for (const section of document.querySelectorAll('[data-variant]')) {
    const name = section.getAttribute('data-variant');
    const actions = [...section.querySelectorAll('[role="link"]')];
    assert(actions.length > 0, name + ': missing actions');
    for (const action of actions) {
      destination = '';
      action.click();
      assert(destination.startsWith('corner:') || destination.startsWith('https://github.com/'), name + ': wrong destination');
    }
    const headers = [...section.querySelectorAll('[data-testid$="-title"]')];
    assert(headers.length === 1 && /^(PR|Corner|Issue|Check|Activity) · /.test(headers[0].textContent), name + ': header');
    assert(!headers[0].textContent.includes('@'), name + ': header author');
    const rows = section.querySelectorAll('[data-testid^="notification-run-cell-"]');
    assert(rows.length >= 1, name + ': row');
    results.push({name, actions: actions.length, header: headers[0].textContent});
  }
  const single = document.querySelector('[data-variant="corner-merged-pr"] [data-testid^="notification-run-cell-"]');
  const groupedOne = document.querySelector('[data-variant="group-of-one"] [data-testid^="notification-run-cell-"]');
  assert(single.textContent === groupedOne.textContent, 'single/group-of-one row content');
  assert(single.getBoundingClientRect().height === groupedOne.getBoundingClientRect().height, 'single/group-of-one row geometry');
  const nameless = document.querySelector('[data-variant="corner-merged-pr-nameless"] [data-testid^="notification-run-cell-"]');
  const namelessOne = document.querySelector('[data-variant="nameless-group-of-one"] [data-testid^="notification-run-cell-"]');
  assert(nameless.textContent === namelessOne.textContent, 'nameless single/group-of-one row content');
  assert(nameless.getBoundingClientRect().height === namelessOne.getBoundingClientRect().height, 'nameless single/group-of-one row geometry');
  const singleIssue = document.querySelector('[data-variant="github-issue-opened"] [data-testid^="notification-run-cell-"]');
  const issueOne = document.querySelector('[data-variant="issue-group-of-one"] [data-testid^="notification-run-cell-"]');
  assert(singleIssue.textContent === issueOne.textContent, 'single/group-of-one issue row content');
  assert(singleIssue.getBoundingClientRect().height === issueOne.getBoundingClientRect().height, 'single/group-of-one issue row geometry');
  const singleIssueHeader = document.querySelector('[data-variant="github-issue-opened"] [data-testid$="-title"]');
  const issueOneHeader = document.querySelector('[data-variant="issue-group-of-one"] [data-testid$="-title"]');
  assert(singleIssueHeader.textContent === issueOneHeader.textContent, 'single/group-of-one issue header');
  assert(document.documentElement.scrollWidth <= innerWidth, 'horizontal overflow');
  document.getElementById('result').textContent = JSON.stringify({source:'local built production components', variants:results});
}
main().catch(error=>document.getElementById('result').textContent = 'FAIL: '+error.message);`);
    for (const theme of ['bone', 'obsidian']) {
      const shims = webProofShims(mobile);
      shims['react-native-unistyles'] = shims['react-native-unistyles']!.replace('beelineThemes.obsidian', `beelineThemes.${theme}`);
      const output = process.env.LIFECYCLE_PROOF_OUT;
      if (output) await mkdir(output, { recursive: true });
      const proof = await runBrowserProof({ entry, mobile, shims, width: 1200, height: 6500,
        ...(output ? { screenshotPath: path.resolve(output, `web-local-${theme}.png`) } : {}),
      });
      expect(proof.status, proof.stderr).toBe(0);
      const result = JSON.parse(proof.result);
      expect(result.variants).toHaveLength(24);
      expect(result.variants.find((v: { name: string }) => v.name === 'mixed-activity').header).toMatch(/^Activity · /);
      expect(result.variants.find((v: { name: string }) => v.name === 'grouped-issues').header).toMatch(/^Issue · /);
      if (output) await writeFile(path.join(output, `web-local-${theme}-results.json`), JSON.stringify(result, null, 2));
      console.log(`Demonstrated lifecycle-cards-2 ${theme}: 24 local web variants, header/row/action destinations pass`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
