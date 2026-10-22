import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { runBrowserProof, webProofShims } from './browserProof';

/** An 80-character consequence, the choice contract's maximum, so wrap is proven. */
const LONG_CONSEQUENCE =
  'Pause the sweep overnight and retry this gate when the desk is free again, soon.';

const SURFACES = [
  { name: 'android', width: 360, height: 780, desktop: false },
  { name: 'desktop', width: 1280, height: 800, desktop: true },
  // 1080×2340 is the phone size from the report. The 360×780 surface is that
  // device at 3×; this pass checks the same cell at the literal pixel size.
  { name: 'android-1080', width: 1080, height: 2340, desktop: false },
] as const;

type Plate = {
  width: number;
  left: number;
  variant: string;
  background: string;
  fits: boolean;
  text: string;
  busy: string | null;
  disabled: string | null;
};

type Line = { top: number; left: number } | null;

function cssRgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

function normColor(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase();
}

function assertEqualPlates(plates: Plate[], primaryFill: string) {
  expect(plates.length).toBeGreaterThan(1);
  const width = plates[0]!.width;
  const left = plates[0]!.left;
  const primary = normColor(cssRgb(primaryFill));
  for (const plate of plates) {
    expect(Math.abs(plate.width - width)).toBeLessThan(1);
    expect(Math.abs(plate.left - left)).toBeLessThan(1);
    expect(plate.width).toBeGreaterThan(200);
    expect(plate.variant).toBe('secondary');
    expect(normColor(plate.background)).not.toBe(primary);
    expect(plate.fits).toBe(true);
  }
}

it('Reproduction tray-choice-1: choice plates share one width and do not repeat the option line', async () => {
  expect(LONG_CONSEQUENCE).toHaveLength(80);
  const mobile = process.cwd();
  const directory = await mkdtemp(path.join(mobile, 'sources/test/tray-choice-plates-'));
  try {
    const entry = path.join(directory, 'proof.jsx');
    const long = JSON.stringify(LONG_CONSEQUENCE);
    await writeFile(entry, `import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { Text, View } from 'react-native';
      import { NeedsYouCell } from '@/components/buzz/NeedsYouCell';
      import { useUnistyles } from 'react-native-unistyles';
      import regularFont from '@/assets/fonts/SpaceGrotesk-Regular.ttf';
      import mediumFont from '@/assets/fonts/SpaceGrotesk-Medium.ttf';
      import semiboldFont from '@/assets/fonts/SpaceGrotesk-SemiBold.ttf';
      const style=document.createElement('style');
      style.textContent=[['SpaceGrotesk-Regular',regularFont],['SpaceGrotesk-Medium',mediumFont],['SpaceGrotesk-SemiBold',semiboldFont]]
        .map(([name,url])=>'@font-face{font-family:'+name+';src:url('+url+')}').join('')+'#result{display:none}';
      document.head.appendChild(style);
      const LONG = ${long};
      const desktop = new URLSearchParams(location.search).get('desktop') === '1';
      const workflowActions = [
        {kind:'choice',choiceId:'gate',optionId:'A',label:'retry',detail:LONG},
        {kind:'choice',choiceId:'gate',optionId:'B',label:'stop',detail:'End the run'},
      ];
      const questionActions = [
        {kind:'choice',choiceId:'q',optionId:'A',label:'Ship now',detail:'Release tonight'},
        {kind:'choice',choiceId:'q',optionId:'B',label:'Wait',detail:'Release after the voice fix lands in the store'},
        {kind:'choice',choiceId:'q',optionId:'C',label:'Retry',detail:'Run the failed step one more time'},
        {kind:'choice',choiceId:'q',optionId:'D',label:'Stop',detail:'End the run and leave the branch as it is'},
        {kind:'skip-choice',choiceId:'q',label:'Skip'},
      ];
      const item = (messageId, subject, detail, actions, roomName) => ({
        messageId, workspaceId:'w', roomId:'r', roomName, roomKind:'room', text:subject,
        createdAt:Math.floor(Date.now()/1000),
        approval:{kind:'choice',actor:messageId==='workflow'?'Sol':'Ruby',ask:'asks you to choose',literal:false,
          subject, detail, actions},
      });
      const calls = [];
      let held = false;
      let releaseHold = () => {};
      function Proof(){
        const { theme }=useUnistyles();
        document.body.style.background=theme.buzz.bgTerminal;
        const onAction = async (_item, action) => {
          calls.push([action.kind, action.optionId ?? null]);
          if (!held) {
            held = true;
            await new Promise(resolve => { releaseHold = resolve; });
          }
        };
        return <View>
          <NeedsYouCell item={item('workflow','The mm-desk gate failed','retry · stop',workflowActions,'mm-desk')}
            now={Date.now()} desktop={desktop} onOpen={()=>{}} onDismiss={()=>{}} onAction={onAction}/>
          <NeedsYouCell item={item('question','Which outcome should the gate take?','Ship now · Wait · Retry · Stop',questionActions,'mm-desk')}
            now={Date.now()} desktop={desktop} onOpen={()=>{}} onDismiss={()=>{}} onAction={onAction}/>
        </View>;
      }
      const plate = (id) => {
        const node = document.querySelector('[data-testid="'+id+'"]');
        const rect = node.getBoundingClientRect();
        const background = getComputedStyle(node).backgroundColor;
        return { width:rect.width, left:rect.left, variant:node.dataset.variant || '', background,
          fits:node.scrollWidth <= node.clientWidth + 1, text:node.textContent,
          busy:node.getAttribute('aria-busy'), disabled:node.getAttribute('aria-disabled') };
      };
      const line = (id, exact) => {
        const plateNode = document.querySelector('[data-testid="'+id+'"]');
        const node = [...plateNode.querySelectorAll('*')].find(el => el.childElementCount === 0 && el.textContent === exact);
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return { top:rect.top, left:rect.left };
      };
      createRoot(document.getElementById('root')).render(<Proof/>);
      setTimeout(async()=>{
        const workflow = [plate('needs-you-action-workflow-0'), plate('needs-you-action-workflow-1')];
        const question = [0,1,2,3].map(index => plate('needs-you-action-question-'+index));
        const retry = line('needs-you-action-workflow-0','retry');
        const consequence = line('needs-you-action-workflow-0', LONG);
        const letter = line('needs-you-action-workflow-0','A');
        document.querySelector('[data-testid="needs-you-action-workflow-0"]').click();
        await new Promise(resolve => setTimeout(resolve, 40));
        const busy = {
          workflow:[0,1].map(index => plate('needs-you-action-workflow-'+index)),
          question:[0,1,2,3].map(index => plate('needs-you-action-question-'+index)),
        };
        releaseHold();
        await new Promise(resolve => setTimeout(resolve, 40));
        for (const id of ['needs-you-action-workflow-1','needs-you-action-question-0','needs-you-action-question-1','needs-you-action-question-2','needs-you-action-question-3','needs-you-action-question-4']) {
          document.querySelector('[data-testid="'+id+'"]').click();
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        const skip = document.querySelector('[data-testid="needs-you-action-question-4"]');
        const last = document.querySelector('[data-testid="needs-you-action-question-3"]');
        const { theme }=useUnistyles();
        document.getElementById('result').textContent=JSON.stringify({
          primaryFill:theme.buzz.buttonPrimaryFill,
          workflow, question, retry, consequence, letter, busy,
          detailWorkflow:!!document.querySelector('[data-testid="needs-you-detail-workflow"]'),
          detailQuestion:!!document.querySelector('[data-testid="needs-you-detail-question"]'),
          workflowSkip:!!document.querySelector('[data-testid="needs-you-action-workflow-2"]'),
          skipText:skip ? skip.textContent : '',
          skipTop:skip ? skip.getBoundingClientRect().top : 0,
          lastBottom:last ? last.getBoundingClientRect().bottom : 0,
          calls, text:document.getElementById('root').textContent,
          overflow:document.documentElement.scrollWidth>innerWidth,
        });
      }, 400);`);
    for (const theme of ['obsidian', 'bone']) {
      for (const surface of SURFACES) {
        const shims = webProofShims(mobile);
        shims['react-native-unistyles'] = shims['react-native-unistyles']!.replace(
          'beelineThemes.obsidian',
          `beelineThemes.${theme}`,
        );
        shims['@/auth/monolith-session'] =
          'export const monolithSession = {}; export const MONOLITH_REQUEST_TIMEOUT_MS = 15000;';
        shims['react-native-gesture-handler'] = 'export const Swipeable = props => props.children;';
        const proof = await runBrowserProof({
          entry,
          mobile,
          width: surface.width,
          height: surface.height,
          shims,
          query: `?desktop=${surface.desktop}`,
          budgetMs: 8000,
          ...(process.env.BEELINE_DESIGN_PROOF_DIR
            ? {
                screenshotPath: path.join(
                  process.env.BEELINE_DESIGN_PROOF_DIR,
                  `tray-choice-1-${surface.name}-${theme}.png`,
                ),
              }
            : {}),
        });
        expect(proof.status, proof.stderr).toBe(0);
        const result = JSON.parse(proof.result) as {
          primaryFill: string;
          workflow: Plate[];
          question: Plate[];
          retry: Line;
          consequence: Line;
          letter: Line;
          busy: { workflow: Plate[]; question: Plate[] };
          detailWorkflow: boolean;
          detailQuestion: boolean;
          workflowSkip: boolean;
          skipText: string;
          skipTop: number;
          lastBottom: number;
          calls: [string, string | null][];
          text: string;
          overflow: boolean;
        };
        assertEqualPlates(result.workflow, result.primaryFill);
        assertEqualPlates(result.question, result.primaryFill);
        expect(result.retry).not.toBeNull();
        expect(result.consequence).not.toBeNull();
        expect(result.letter).not.toBeNull();
        expect(result.consequence!.top).toBeGreaterThan(result.retry!.top);
        expect(Math.abs(result.consequence!.left - result.retry!.left)).toBeLessThan(1);
        expect(result.letter!.left).toBeLessThan(result.retry!.left);
        expect(result.detailWorkflow).toBe(false);
        expect(result.detailQuestion).toBe(false);
        expect(result.text).not.toContain('retry · stop');
        expect(result.text).not.toContain('Ship now · Wait · Retry · Stop');
        expect(result.text).toContain(LONG_CONSEQUENCE);
        expect(result.workflowSkip).toBe(false);
        expect(result.skipText).toContain('Skip');
        expect(result.skipTop).toBeGreaterThanOrEqual(result.lastBottom - 1);
        expect(normColor(cssRgb(result.primaryFill))).not.toBe(
          normColor(
            result.question[0]!.background,
          ),
        );
        expect(result.busy.workflow[0]!.busy).toBe('true');
        expect(result.busy.workflow[0]!.disabled).toBe('true');
        expect(result.busy.workflow[1]!.busy).not.toBe('true');
        expect(result.busy.workflow[1]!.disabled).not.toBe('true');
        for (const plate of result.busy.question) {
          expect(plate.busy).not.toBe('true');
          expect(plate.disabled).not.toBe('true');
        }
        expect(result.calls).toEqual([
          ['choice', 'A'],
          ['choice', 'B'],
          ['choice', 'A'],
          ['choice', 'B'],
          ['choice', 'C'],
          ['choice', 'D'],
          ['skip-choice', null],
        ]);
        expect(result.overflow).toBe(false);
        console.log(
          `Reproduction tray-choice-1 ${surface.name} ${theme}: widths ${result.workflow.map((plate) => Math.round(plate.width)).join(',')} / ${result.question.map((plate) => Math.round(plate.width)).join(',')}`,
        );
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 240_000);
