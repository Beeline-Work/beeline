import React from 'react';
// @ts-expect-error Standalone proof uses installed react-dom.
import { createRoot } from 'react-dom/client';
import { DisclosureRowsProof, repositoryId } from './disclosure-rows-proof';

createRoot(document.getElementById('root')!).render(<DisclosureRowsProof />);
const pause = () => new Promise((resolve) => setTimeout(resolve, 80));
const get = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
const assert = (ok: unknown, why: string) => {
  if (!ok) throw Error(why);
};
async function main() {
  await document.fonts.ready;
  await pause();
  const before = location.search.includes('before');
  const theme = location.search.includes('bone') ? 'bone' : 'obsidian';
  const rows = [
    ['tool-run-group-read', 'tool-ledger-line-read'],
    [`notification-run-expand-${repositoryId}`, `notification-run-cell-${repositoryId}`],
    ['notification-run-expand-checks', 'notification-run-cell-check'],
    ['notification-run-expand-payments', 'notification-run-cell-pay-1'],
    ['notification-run-expand-notices', 'notification-run-cell-notice-1'],
    ['inline-output-toggle', 'inline-output-body'],
    ['script-toggle', 'script'],
  ];
  for (const [id, child] of rows) {
    const row = get(id);
    assert(row.getBoundingClientRect().height >= 44, `${id}: tap height below 44`);
    // The repository edge lives on the wrapper, so checking only the button misses it.
    const topEdge = [row, row.parentElement!].some(
      (node) => parseFloat(getComputedStyle(node).borderTopWidth) > 0,
    );
    assert(topEdge === before, `${id}: ${before ? 'missing original edge' : 'top edge returned'}`);
    const mark = row.querySelector('svg')!;
    const label = row.querySelector('[dir="auto"]')!;
    assert(mark.getAttribute('width') === '14', `${id}: chevron size`);
    assert(mark.querySelector('polyline')?.getAttribute('points') === '9 6 15 12 9 18', `${id}: closed direction`);
    assert(mark.querySelector('polyline')?.getAttribute('stroke') === (theme === 'bone' ? '#8B7F6E' : '#83838d'), `${id}: muted colour`);
    assert(Math.abs(label.getBoundingClientRect().left - row.getBoundingClientRect().left - 22) < 1, `${id}: label not at 22px`);
    assert(getComputedStyle(label).fontFamily.includes('SpaceGrotesk'), `${id}: sans label`);
    const box = row.getBoundingClientRect();
    document
      .elementFromPoint(box.right - 2, box.top + 2)!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await pause();
    assert(get(child), `${id}: top-right tap did not expand`);
    assert(mark.querySelector('polyline')?.getAttribute('points') === '6 9 12 15 18 9', `${id}: open direction`);
    const expandedBox = row.getBoundingClientRect();
    document
      .elementFromPoint(expandedBox.left + 2, expandedBox.bottom - 2)!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await pause();
    assert(!get(child), `${id}: bottom-left tap did not collapse`);
  }
  const steps = get(rows[0][0]).getBoundingClientRect();
  assert(
    get('next-message').getBoundingClientRect().top - steps.bottom >= 24,
    'next-message spacing lost',
  );
  assert(document.documentElement.scrollWidth <= innerWidth, 'horizontal overflow');
  for (const [id] of rows) { get(id).click(); await pause(); }
  assert(get('tool-run-more-read'), 'long steps run needs N more');
  assert(!get('tool-ledger-line-edit'), 'long run shows only two steps initially');
  get('tool-run-more-read').click(); await pause();
  assert(get('tool-ledger-line-edit'), 'N more must reveal failed step');
  assert(get('tool-ledger-line-edit').querySelector('polyline')?.getAttribute('stroke') === (theme === 'bone' ? '#8a6323' : '#b08a4a'), 'tool destination needs brass chevron');
  document.getElementById('result')!.textContent =
    `PASS DISCLOSURE-EDGE: ${before ? 'original edge' : 'no edge'}, 44px targets, edge taps expand/collapse, next-message spacing`;
}
main().catch((error) => {
  document.getElementById('result')!.textContent = `FAIL: ${error.message}`;
});
