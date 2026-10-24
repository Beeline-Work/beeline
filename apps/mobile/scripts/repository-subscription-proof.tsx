import React from 'react';
// @ts-expect-error Standalone proof uses installed react-dom.
import { createRoot } from 'react-dom/client';
import { LedgerSystemLine } from '../sources/components/buzz/Ledger';
import { repositorySubscriptionLine } from '../../server/src/repository-subscription-line';
import { beelineThemes } from '../sources/buzz/groknight';
const fonts = document.createElement('style');
fonts.textContent = `
  @font-face{font-family:SpaceGrotesk-Regular;src:url(${require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf')})}
  @font-face{font-family:SpaceGrotesk-Medium;src:url(${require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf')})}
  @font-face{font-family:IBMPlexMono-Regular;src:url(${require('../sources/assets/fonts/IBMPlexMono-Regular.ttf')})}
`;
document.head.appendChild(fonts);
const phrase = repositorySubscriptionLine('issue.opened', 'Beeline-Work/beeline-insights', {
  number: 7, title: '[grok] x-read-2026-10-23-2 X Ads Manager campaigns',
  html_url: 'https://github.com/Beeline-Work/beeline-insights/issues/7',
});
const event = { ...phrase, kind: 'subscription-fired' as const };
const text = `GitHub opened issue ${event.object!.text} · ${event.consequence}`;
document.documentElement.style.width = '390px';
document.body.style.width = '390px';
document.body.style.background = beelineThemes.obsidian.bgBase;
document.body.style.color = '#f0f0f3';
createRoot(document.getElementById('root')!).render(
  <div style={{padding: 16, minHeight: 400}}>
    <div style={{fontFamily:'sans-serif', paddingBottom: 32}}># beeline-insights</div>
    <LedgerSystemLine id="repository" text={text} event={event} stamp="12:00"
      onOpenUrl={(url) => document.body.dataset.opened = url} />
  </div>,
);
setTimeout(() => {
  try {
    if (document.body.getBoundingClientRect().width !== 390) throw Error('Wrong Room width');
    (document.querySelector('[data-testid="system-line-toggle-repository"]') as HTMLElement | null)?.click();
    const link = document.querySelector('[data-testid="system-line-object-repository"]') as HTMLElement;
    if (!link?.textContent?.startsWith('#7')) throw Error('Missing linked issue');
    link.click();
    if (document.body.dataset.opened !== event.object!.url) throw Error('Wrong link destination');
    if (document.body.scrollWidth > 390) throw Error('Horizontal overflow');
    document.getElementById('result')!.textContent = 'PASS SUB-LINK — issue tap opens its GitHub URL';
  } catch (error) { document.getElementById('result')!.textContent = `FAIL ${error}`; }
}, 800);
