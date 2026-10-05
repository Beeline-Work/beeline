import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

it.skipIf(!existsSync(CHROME))('walks the actual webhook settings at phone and desktop widths', async () => {
  const mobile = process.cwd();
  const shims = webProofShims(mobile);
  shims['react-native-reanimated'] += '\nexport const FadeOut = FadeInDown; export const interpolateColor = (_,__,colors) => colors[0];';
  shims['@/sync/transport/monolith-operation'] = `
    const hook={id:'hook',source:'price-feed',signed:false,revoked:false};
    let pending=true;
    export const phoneOperationFailureReason = e => String(e);
    export async function monolithPhoneOperation(name,input) {
      if(name==='readRoomWebhooks')return {sources:[{...hook}],requests:pending?[{requestId:'request',agentId:'bee',agentName:'Bee',source:'oracle',reason:'Receive outside market signals',status:'pending',expiresAt:2000000000}]:[],deliveries:[]};
      if(name==='decideWebhookRequest') {
        if(!input.approve || input.signingSecret!=='approval-secret' || input.revealSecret)throw Error('Approval ignored private secret');
        pending=false; return {status:'approved'};
      }
      if(input.action==='rotate')return {url:'https://example.invalid/v1/hooks/one-time-test-token'};
      if(input.action==='secret')hook.signed=Boolean(input.signingSecret);
      if(input.action==='revoke')hook.revoked=true;
      return {};
    }`;
  const captureRoot = path.join(mobile, '.impeccable/review');
  mkdirSync(captureRoot, { recursive: true });
  for (const width of [390, 1280]) {
    const result = await runBrowserProof({ mobile, entry: path.join(mobile, 'scripts/room-webhooks-proof.tsx'), shims, width, height: 844 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.result).toContain('controls: rotate URL once, private secret, clear, revoke passed');
    expect(result.result).toContain('approval: typed signing secret kept private, request removed');
    expect(result.result).toContain('signed:'); expect(result.result).toContain('Signed'); expect(result.result).toContain('Revoked');
    console.log(width, result.result);
    const capture = await runBrowserProof({ mobile, entry: path.join(mobile, 'scripts/room-webhooks-proof.tsx'), shims, width, height: 844, query: '?capture=1', screenshotPath: path.join(captureRoot, width === 390 ? 'mobile.png' : 'desktop.png') });
    expect(capture.result).toContain('captured real RoomWebhooksSettings');
  }
}, 90_000);
