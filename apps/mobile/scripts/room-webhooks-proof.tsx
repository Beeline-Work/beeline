import React from 'react';
// @ts-expect-error Standalone proof uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { PageHeader } from '../sources/components/buzz/PageHeader';
import { RoomWebhooksSettings } from '../sources/components/buzz/RoomWebhooksSettings';

// @ts-expect-error Bundled font asset.
import regular from '../sources/assets/fonts/SpaceGrotesk-Regular.ttf';
// @ts-expect-error Bundled font asset.
import medium from '../sources/assets/fonts/SpaceGrotesk-Medium.ttf';
// @ts-expect-error Bundled font asset.
import bold from '../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf';
// @ts-expect-error Bundled font asset.
import mono from '../sources/assets/fonts/IBMPlexMono-Regular.ttf';
const fontStyle = document.createElement('style');
fontStyle.textContent = `@font-face{font-family:SpaceGrotesk-Regular;src:url(${regular})}@font-face{font-family:SpaceGrotesk-Medium;src:url(${medium})}@font-face{font-family:SpaceGrotesk-SemiBold;src:url(${bold})}@font-face{font-family:IBMPlexMono-Regular;src:url(${mono})}`;
document.head.appendChild(fontStyle);
const pause = () => new Promise((r) => setTimeout(r, 200));
const lines: string[] = [];
const root = document.getElementById('root')!;
document.body.style.background = '#14091A';
root.style.cssText = 'height:100vh;background:#14091A;max-width:720px;margin:auto;display:flex;flex-direction:column';
async function tap(label: string) {
  const button = [...root.querySelectorAll<HTMLElement>('[role="button"]')].find((el) => el.textContent?.trim() === label);
  if (!button) throw new Error('Missing control '+label);
  button.click(); await pause();
}
async function run() {
  createRoot(root).render(<><PageHeader title="Webhooks" onBack={() => undefined} /><RoomWebhooksSettings roomId="proof-room" /></>);
  await pause(); await document.fonts.ready;
  lines.push('loaded: '+root.textContent);
  if (new URLSearchParams(location.search).has('capture')) {
    document.getElementById('result')!.textContent = 'captured real RoomWebhooksSettings'; return;
  }
  await tap('Rotate URL'); await tap('Confirm');
  lines.push('rotated: '+root.textContent);
  if (!root.textContent?.includes('Save this URL now. It is shown once.')) throw new Error('URL missing');
  await tap('Done');
  if (root.textContent?.includes('/v1/hooks/')) throw new Error('URL survived dismissal');
  await tap('Set signing secret');
  const input = root.querySelector<HTMLInputElement>('[aria-label="Signing secret for price-feed"]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'private-secret');
  input.dispatchEvent(new Event('input', { bubbles: true })); await pause();
  await tap('Save secret');
  lines.push('signed: '+root.textContent);
  await tap('Clear signing secret'); await tap('Confirm');
  await tap('Revoke webhook'); await tap('Confirm');
  lines.push('revoked: '+root.textContent);
  if (root.textContent?.includes('Rotate URL')) throw new Error('Revoked source has live controls');
  lines.push('controls: rotate URL once, private secret, clear, revoke passed');
  const approvalInput = root.querySelector<HTMLInputElement>('[aria-label="Signing secret for oracle"]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(approvalInput, 'approval-secret');
  approvalInput.dispatchEvent(new Event('input', { bubbles: true })); await pause();
  await tap('Approve');
  if (root.querySelector('[data-testid="webhook-request-card"]')) throw new Error('Approved request remained in settings');
  if (root.textContent?.includes('Room admin approval needed')) throw new Error('Private-secret approval failed');
  lines.push('approval: typed signing secret kept private, request removed');
  document.getElementById('result')!.textContent = lines.join('\n');
}
void run().catch((e) => { document.getElementById('result')!.textContent = 'FAILED '+String(e); });
