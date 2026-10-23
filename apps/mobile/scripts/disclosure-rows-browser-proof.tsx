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
  const rows = [
    ['tool-run-group-read', 'tool-ledger-line-read'],
    [`notification-run-expand-${repositoryId}`, `notification-run-cell-${repositoryId}`],
    ['notification-run-expand-checks', 'notification-run-cell-check'],
  ];
  for (const [id, child] of rows) {
    const row = get(id);
    assert(row.getBoundingClientRect().height >= 44, `${id}: tap height below 44`);
    // The repository edge lives on the wrapper, so checking only the button misses it.
    const topEdge = [row, row.parentElement!].some(
      (node) => parseFloat(getComputedStyle(node).borderTopWidth) > 0,
    );
    assert(topEdge === before, `${id}: ${before ? 'missing original edge' : 'top edge returned'}`);
    const box = row.getBoundingClientRect();
    document
      .elementFromPoint(box.right - 2, box.top + 2)!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await pause();
    assert(get(child), `${id}: top-right tap did not expand`);
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
  document.getElementById('result')!.textContent =
    `PASS DISCLOSURE-EDGE: ${before ? 'original edge' : 'no edge'}, 44px targets, edge taps expand/collapse, next-message spacing`;
}
main().catch((error) => {
  document.getElementById('result')!.textContent = `FAIL: ${error.message}`;
});
