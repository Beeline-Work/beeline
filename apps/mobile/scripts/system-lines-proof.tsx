import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { LedgerSystemLine } from '../sources/components/buzz/Ledger';
import { beelineThemes } from '../sources/buzz/groknight';
import { anchorRelayReports } from '../sources/buzz/system-lines';
const consequence =
  'Execute directly in the corner under its current brief. Preserve the existing ledger, spending caps, expiry and calendar guards. Deduplicate timers against canonical receipts and active runs. Read the required records before executing. Keep one ledger and preserve uncertain calls. Save receipts and report timestamps, then report to the parent Room. '.repeat(
    3,
  ) + 'Original message ends here.';
const messages = ['first', 'second'].map((id, index) => ({
  id,
  timestamp: index + 1,
  text: `Scheduler ran a schedule for Ruby · ${consequence}`,
  isSystemNotice: true,
  systemEvent: {
    subject: { kind: 'agent' as const, id: 'ruby', name: 'Scheduler' },
    verb: 'ran a schedule',
    object: { text: 'for Ruby', url: 'https://example.test/job' },
    consequence,
  },
}));
const assert = (ok: boolean, why: string) => {
  if (!ok) throw new Error(why);
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
const get = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
const row = (id: string) => get(`system-line-text-${id}`);
const toggle = (id: string) => get(`system-line-toggle-${id}`);
const checkCollapsed = (id: string) => {
  const element = row(id);
  assert(getComputedStyle(element).webkitLineClamp === '2', `${id} not capped at two lines`);
  assert(
    element.clientHeight <= parseFloat(getComputedStyle(element).lineHeight) * 2 + 1,
    `${id} taller than two lines`,
  );
  assert(toggle(id)?.textContent === 'More', `${id} missing More`);
};
async function measure() {
  const root = document.getElementById('root')!;
  const fontStyle = document.createElement('style');
  fontStyle.textContent = `
    @font-face{font-family:SpaceGrotesk-Regular;src:url(${require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf')})}
    @font-face{font-family:SpaceGrotesk-Medium;src:url(${require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf')})}
    @font-face{font-family:IBMPlexMono-Regular;src:url(${require('../sources/assets/fonts/IBMPlexMono-Regular.ttf')})}
    #result{white-space:pre-wrap;color:inherit}
  `;
  document.head.appendChild(fontStyle);
  await Promise.all(
    ['SpaceGrotesk-Regular', 'SpaceGrotesk-Medium', 'IBMPlexMono-Regular'].map((font) =>
      document.fonts.load(`13px ${font}`),
    ),
  );
  const theme = location.search.includes('bone') ? beelineThemes.bone : beelineThemes.obsidian;
  document.body.style.backgroundColor = theme.bgBase;
  document.body.style.color = theme.ledgerQuiet;
  root.style.padding = '16px';
  root.style.boxSizing = 'border-box';
  if (location.search.includes('large')) {
    const style = document.createElement('style');
    style.textContent =
      '[data-testid^="system-line-text-"],[data-testid^="system-line-measurement-"], [data-testid^="system-line-toggle-"] > *{font-size:26px!important;line-height:38px!important}';
    document.head.appendChild(style);
  }
  createRoot(root).render(
    <>
      {anchorRelayReports(messages).map((m) => (
        <LedgerSystemLine
          key={m.id}
          id={m.id}
          text={m.text}
          event={m.systemEvent}
          stamp={String(m.timestamp)}
          onOpenIdentity={() => (root.dataset.identity = 'ruby')}
          onOpenUrl={() => (root.dataset.url = 'job')}
        />
      ))}
      <LedgerSystemLine id="short" text="Ruby joined" stamp="3" />
      <LedgerSystemLine id="legacy" text={'Legacy notice\nSecond line\nThird line'} stamp="4" />
    </>,
  );
  await settle();
  checkCollapsed('first');
  checkCollapsed('second');
  checkCollapsed('legacy');
  assert(!toggle('short'), 'short message has an unnecessary More');
  assert(row('short').textContent === 'Ruby joined', 'short text changed');
  const control = toggle('first');
  assert(
    control.getAttribute('role') === 'button' && control.getAttribute('aria-expanded') === 'false',
    'collapsed accessibility state missing',
  );
  assert(control.clientHeight >= 44 && control.clientWidth >= 44, 'small toggle target');
  assert(
    getComputedStyle(control.firstElementChild!).color ===
      getComputedStyle(get('system-line-name-first-0')).color,
    'More is not brass',
  );
  assert(control.getAttribute('tabindex') === '0', 'control is not keyboard reachable');
  control.click();
  await settle();
  assert(toggle('first').textContent === 'Less', 'Less missing');
  assert(
    toggle('first').getAttribute('aria-expanded') === 'true',
    'expanded accessibility state missing',
  );
  assert(row('first').scrollHeight <= row('first').clientHeight + 1, 'expanded text clipped');
  assert(row('first').textContent === messages[0].text, 'original message changed');
  assert(row('first').textContent!.endsWith('Original message ends here.'), 'suffix lost');
  checkCollapsed('second');
  get('system-line-name-first-0').click();
  get('system-line-object-first').click();
  assert(
    root.dataset.identity === 'ruby' && root.dataset.url === 'job',
    'existing actions stopped working',
  );
  assert(get('system-line-stamp-first').textContent === '1', 'timestamp changed');
  toggle('first').click();
  await settle();
  checkCollapsed('first');
  // Dump-DOM virtual time does not advance compositor frames after the initial layout.
  // The real-time browser run also verifies ResizeObserver updates.
  if (location.search.includes('resize')) {
    root.style.width = '10000px';
    await settle();
    assert(
      !toggle('first'),
      `More remained after overflow disappeared: measurement=${get('system-line-measurement-first').getBoundingClientRect().height}, width=${get('system-line-measurement-first').getBoundingClientRect().width}`,
    );
    root.style.width = '240px';
    await settle();
    checkCollapsed('first');
    root.style.width = '';
    await settle();
  }
  toggle('second').click();
  await settle();
  get('system-line-second').scrollIntoView();
  document.getElementById('result')!.textContent =
    'PASS: two-line previews, brass More/Less, full original text, short and legacy messages, independent expansion, accessible controls, stamps and links';
}
measure().catch((error) => (document.getElementById('result')!.textContent = String(error)));
