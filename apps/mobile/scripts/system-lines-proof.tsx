import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { LedgerSystemLine } from '../sources/components/buzz/Ledger';
import { anchorRelayReports } from '../sources/buzz/system-lines';
const consequence =
  'the helper could not authenticate with Claude. If its login expired, its owner can send the agent’s /login command here, or run beeline connect on its machine.';
const messages = ['first', 'second'].map((id, index) => ({
  id,
  timestamp: index + 1,
  text: `Ruby could not answer · ${consequence}`,
  isSystemNotice: true,
  systemEvent: {
    subject: { kind: 'agent' as const, id: 'ruby', name: 'Ruby' },
    verb: 'could not answer',
    consequence,
  },
}));
const assert = (ok: boolean, why: string) => {
  if (!ok) throw new Error(why);
};
async function measure() {
  const root = document.getElementById('root')!;
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
        />
      ))}
    </>,
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
  const rows = document.querySelectorAll('[data-testid^="system-line-text-"]');
  const failures: string[] = [];
  if (rows.length !== 2) failures.push(`expected 2 separate notices, saw ${rows.length}`);
  for (const row of rows) {
    if (location.search.includes('large')) {
      (row as HTMLElement).style.fontSize = '26px';
      (row as HTMLElement).style.lineHeight = '38px';
    }
    const style = getComputedStyle(row);
    if (style.webkitLineClamp !== 'none' && style.webkitLineClamp !== '')
      failures.push(`text capped at ${style.webkitLineClamp} lines`);
    if (row.scrollHeight > row.clientHeight + 1) failures.push('recovery copy clipped');
    assert(row.textContent!.includes('beeline connect on its machine.'), 'recovery suffix lost');
  }
  assert(failures.length === 0, failures.join('; '));
  assert(
    document.querySelector('[data-testid="system-line-stamp-first"]')!.textContent === '1',
    'first timestamp changed',
  );
  (document.querySelector('[data-testid="system-line-name-first-0"]') as HTMLElement).click();
  assert(root.dataset.identity === 'ruby', 'identity link stopped working');
  document.querySelector('[data-testid="system-line-second"]')!.scrollIntoView();
  document.getElementById('result')!.textContent =
    'PASS: two separate notices, full recovery text, original stamps, identity link and second-message anchor';
}
measure().catch((error) => (document.getElementById('result')!.textContent = String(error)));
