import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { LedgerSystemLine } from '../sources/components/buzz/Ledger';
import { beelineThemes } from '../sources/buzz/groknight';
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
const edgeEvent = {
  subject: { kind: 'agent' as const, id: 'jellybean', name: '@jellybean' },
  verb: 'reported to',
  object: { id: 'lunchboxfortwo', text: '@lunchboxfortwo' },
  consequence:
    'failed: the nightly release stopped because the android-build check failed and nothing shipped. It retries tomorrow',
};
// Large type sweeps wider boxes so the longest word still fits one line.
const sweep = Array.from(
  { length: 81 },
  (_, step) => (location.search.includes('large') ? 300 : 200) + step,
);
const caller = ('**bold** [link](https://example.test) @ruby https://example.test ' + 'x'.repeat(1000)).slice(0, 1000);
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
  assert(!toggle(id)?.querySelector('svg'), `${id} has a chevron`);
  assert(element.textContent!.endsWith('…\u00A0more'), `${id} does not end in "… more"`);
  assertWordOnLine(id, 2);
};
// The toggle word shares a line with the glyph before it and sits on the given line.
const assertWordOnLine = (id: string, line: number) => {
  const box = row(id);
  const word = get(`system-line-toggle-word-${id}`);
  const rects = word.getClientRects();
  assert(rects.length === 1, `${id}: toggle word split across lines`);
  const lineHeight = parseFloat(getComputedStyle(box).lineHeight);
  const top = box.getBoundingClientRect().top;
  assert(
    Math.abs(rects[0]!.top - top - lineHeight * (line - 1)) < lineHeight / 2,
    `${id}: toggle word not on line ${line}`,
  );
  assert(rects[0]!.right <= box.getBoundingClientRect().right + 0.5, `${id}: toggle word clipped`);
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  let previous: Text | null = null;
  while (walker.nextNode()) {
    if (word.contains(walker.currentNode)) break;
    if ((walker.currentNode as Text).data.length) previous = walker.currentNode as Text;
  }
  const range = document.createRange();
  range.setStart(previous!, previous!.data.length - 1);
  range.setEnd(previous!, previous!.data.length);
  assert(
    Math.abs(range.getBoundingClientRect().top - rects[0]!.top) < lineHeight / 2,
    `${id}: toggle word alone on a new line`,
  );
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
      '[data-testid^="system-line-text-"],[data-testid^="system-line-measurement-"],[data-testid^="system-line-probe-"], [data-testid^="system-line-toggle-"] > *{font-size:26px!important;line-height:38px!important}';
    document.head.appendChild(style);
  }
  createRoot(root).render(
    <>
      {Array.from(messages).map((m) => (
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
      <LedgerSystemLine id="caller" text="Beeline received a webhook call" stamp="5"
        event={{ subject: { kind: 'system', name: 'Beeline' }, verb: 'received',
          object: { text: 'a webhook call' }, kind: 'subscription-fired',
          payload: { source: 'webhook', body: { message: caller } } }}
        onOpenIdentity={() => (root.dataset.callerAction = 'identity')}
        onOpenUrl={() => (root.dataset.callerAction = 'url')} />
      <LedgerSystemLine id="short" text="Ruby joined" stamp="3" />
      {/* One long line at every width in a range, so the last word meets the edge. */}
      {sweep.map((width) => (
        <div key={width} style={{ width }}>
          <LedgerSystemLine id={`sweep-${width}`} text="" event={edgeEvent} stamp="09:03" />
        </div>
      ))}
      <LedgerSystemLine id="legacy" text={'Legacy notice\nSecond line\nThird line'} stamp="4" />
    </>,
  );
  // Overflow measurement and the cut search commit separately after RN Web's
  // initial layout callback. A fixed delay can expire between those commits
  // when Chrome runs alongside the rest of the mobile suite.
  const collapsedIds = ['first', 'second', 'legacy', ...sweep.map((width) => `sweep-${width}`)];
  for (let attempt = 0; attempt < 10; attempt++) {
    await settle();
    if (collapsedIds.every((id) => row(id)?.textContent?.endsWith('…\u00A0more'))) break;
  }
  const callerLabel = get('system-line-caller-label-caller');
  const callerQuote = get('system-line-caller-message-caller');
  assert(callerLabel.textContent === "Caller's message:", 'caller label missing');
  assert(callerLabel.nextElementSibling === callerQuote, 'caller quote is not under its own label');
  assert(callerQuote.textContent === `“${caller.slice(0, 279)}…”`, 'caller preview is not capped with an ellipsis');
  assert(Array.from(callerQuote.textContent!.slice(1, -1)).length === 280, 'caller preview exceeds its cap');
  assert(callerQuote.children.length === 0, 'caller words were parsed as markup or mentions');
  assert(!callerQuote.querySelector('a,button,[role="link"]'), 'caller URL or mention became an action');
  callerQuote.click();
  assert(!root.dataset.callerAction, 'caller text activated an identity or URL');
  assert(row('caller').textContent === 'Beeline received a webhook call', 'caller text became Beeline wording');
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
  const accent = location.search.includes('bone') ? beelineThemes.bone.accent : beelineThemes.obsidian.accent;
  const more = get('system-line-toggle-word-first');
  assert(more.textContent === '\u00A0more', 'closed word is not more');
  assert(getComputedStyle(more).fontFamily.includes('SpaceGrotesk-Medium'), 'more is not weight 500');
  const swatch = document.body.appendChild(document.createElement('span'));
  swatch.style.color = accent;
  assert(getComputedStyle(more).color === getComputedStyle(swatch).color, 'more is not the accent colour');
  swatch.remove();
  assert(control.getAttribute('tabindex') === '0', 'control is not keyboard reachable');
  control.click();
  await settle();
  assert(!toggle('first').querySelector('svg'), 'open line has a chevron');
  assert(get('system-line-toggle-word-first').textContent === '\u00A0less', 'open word is not less');
  assert(
    toggle('first').getAttribute('aria-expanded') === 'true',
    'expanded accessibility state missing',
  );
  assert(row('first').scrollHeight <= row('first').clientHeight + 1, 'expanded text clipped');
  assert(row('first').textContent === `${messages[0].text}\u00A0less`, 'original message changed');
  assertWordOnLine('first', Math.round(row('first').clientHeight / parseFloat(getComputedStyle(row('first')).lineHeight)));
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
  for (const width of sweep) checkCollapsed(`sweep-${width}`);
  for (const width of sweep) toggle(`sweep-${width}`).click();
  await settle();
  for (const width of sweep) {
    const id = `sweep-${width}`;
    const lines = Math.round(row(id).clientHeight / parseFloat(getComputedStyle(row(id)).lineHeight));
    assert(row(id).textContent!.endsWith('tomorrow\u00A0less'), `${id}: less does not follow the text`);
    assertWordOnLine(id, lines);
  }
  for (const width of sweep) toggle(`sweep-${width}`).click();
  await settle();
  toggle('second').click();
  await settle();
  get('system-line-second').scrollIntoView();
  document.getElementById('result')!.textContent =
    `PASS: two-line previews ending in "… more", no chevrons, "less" after the full original text, short and legacy messages, independent expansion, accessible controls, stamps and links; caller words labelled, capped at 280 characters and rendered as inert plain text; "more" and "less" never alone on a line at ${sweep.length} widths`;
}
measure().catch((error) => (document.getElementById('result')!.textContent = String(error)));
