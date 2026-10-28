import React from 'react';
// @ts-expect-error Standalone proof uses installed react-dom.
import { createRoot } from 'react-dom/client';
// @ts-expect-error Source-derived module supplied by browser test.
import { runInvite } from 'invite-handler-proof';
const root = createRoot(document.getElementById('root')!);
(globalThis as any).showInvite = (Component: any, props: any) => root.render(<Component {...props} onClose={() => {}} />);
Object.defineProperty(navigator, 'share', {value: undefined, configurable: true});
void runInvite().then(() => setTimeout(() => {
  const text = document.body.textContent ?? '';
  const input = document.querySelector('input[aria-label="Invite link"]') as HTMLInputElement;
  document.getElementById('result')!.textContent = JSON.stringify({ link: input?.value, copy: text.includes('Copy'), email: !!document.querySelector('input[aria-label="Email address"]') });
}, 600));
