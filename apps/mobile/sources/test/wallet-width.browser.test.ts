import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { runBrowserProof, webProofShims } from './browserProof';

describe('DESKTOP-WALLET-1: real Wallet page width across states', () => {
  for (const width of [500, 1280, 1440, 1920]) {
    it.each(['populated', 'loading', 'error'])(`centres %s at ${width}px`, async state => {
      const mobile = process.cwd();
      const directory = await mkdtemp(path.join(mobile, 'sources/test/wallet-width-'));
      const evidence = process.env.WALLET_WIDTH_EVIDENCE;
      if (evidence) mkdirSync(evidence, { recursive: true });
      try {
        const entry = path.join(directory, 'proof.jsx');
        const fonts = ['SpaceGrotesk-Regular', 'SpaceGrotesk-Medium', 'SpaceGrotesk-SemiBold',
          'IBMPlexMono-Regular', 'IBMPlexMono-Italic', 'IBMPlexMono-SemiBold']
          .map(name => `@font-face{font-family:'${name}';src:url(data:font/ttf;base64,${readFileSync(path.join(mobile, 'sources/assets/fonts', `${name}.ttf`)).toString('base64')})}`).join('');
        await writeFile(entry, `import React from 'react'; import { createRoot } from 'react-dom/client';
          window.addEventListener('error',e=>document.getElementById('result').textContent=JSON.stringify({error:e.message})); import('@/app/(app)/beeline/settings/workbench/wallet').then(({default:Wallet})=>{
          createRoot(document.getElementById('root')).render(<Wallet />);
          setTimeout(() => {
            const r = document.querySelector('[data-testid="wallet-header"]').parentElement.getBoundingClientRect();
            document.getElementById('result').textContent = JSON.stringify({ width:r.width,
              centred:Math.abs(r.x-(innerWidth-r.width)/2)<1,
              address:document.querySelector('[data-testid="wallet-address-value"]')?.textContent,
              balance:document.querySelector('[data-testid="wallet-balance-value"]')?.textContent,
              asset:!!document.querySelector('[data-testid="wallet-coin-USDC"]'),
              loading:!!document.querySelector('[data-testid="wallet-loading"]'),
              error:!!document.querySelector('[data-testid="wallet-network-unavailable"]') });
          }, 1000); }).catch(e=>document.getElementById('result').textContent=JSON.stringify({error:e.message}));`);
        const fixture = `{address:'0x1234567890abcdef',totalUsd:'$42.00',coins:[{symbol:'USDC',name:'USD Coin',amount:'42 USDC',usd:'$42.00'}],delegation:{active:true,expiresAt:null}}`;
        const shims = {
          ...webProofShims(mobile),
          '@/buzz/latency-route-hook': 'export const useLatencyRouteFrame=()=>{};',
          '@/sync/transport/monolith-operation': 'export const phoneOperationFailureReason=e=>String(e);',
          '@/buzz/wallet-surface': `const wallet=${fixture}; export const useSharedWallet=()=>({value:${state === 'populated' ? 'wallet' : 'null'},error:${state === 'error' ? "'offline'" : 'null'},refresh:async()=>{}}); export const useSharedWalletHistory=()=>({value:{entries:[]},error:null,refresh:async()=>{}});`,
          '@/buzz/workbench-surface': 'export const useSharedWorkbench=()=>({value:null});',
          '@/buzz/wallet-workspace': 'export const resolveWalletWorkspaceId=async()=>"workspace-1";',
          '@/buzz/use-active-community': 'export const useActiveCommunityId=()=>"workspace-1";',
          '@/buzz/wallet-source': 'export const getWalletSource=()=>({});',
          '@/buzz/wallet-icons': 'export const tokenIcon=()=>null; export const chainIcon=()=>null;',
          '@/components/buzz/WalletQr': 'export const WalletQr=()=>null;',
          'expo-router': 'export const useLocalSearchParams=()=>({workspaceId:"workspace-1"}); export const router={back(){},push(){}};',
        };
        const baseline = process.env.WALLET_WIDTH_SOURCE;
        if (baseline) Object.assign(shims, { '@/app/(app)/beeline/settings/workbench/wallet': readFileSync(baseline, 'utf8') });
        const proof = await runBrowserProof({ mobile, entry, shims, width,
          head: `<style>html,body{overflow:hidden}#root{height:900px;display:flex;flex-direction:column}${fonts}</style>`,
          screenshotPath: evidence ? path.join(evidence, `${state}-${width}.png`) : undefined });
        expect(proof.status, proof.stderr).toBe(0);
        const result = JSON.parse(proof.result);
        if (evidence) writeFileSync(path.join(evidence, `${state}-${width}.json`), JSON.stringify(result, null, 2)+'\n');
        expect(result.width, JSON.stringify(result)).toBe(baseline ? width : width >= 768 ? 640 : width);
        expect(result.centred).toBe(true);
        if (state === 'populated') {
          expect(result.address).toBe('0x1234567890abcdef');
          expect(result.balance).toBe('$42.00');
          expect(result.asset).toBe(true);
        } else expect(result[state]).toBe(true);
      } finally { await rm(directory, { recursive: true, force: true }); }
    }, 90_000);
  }
});
