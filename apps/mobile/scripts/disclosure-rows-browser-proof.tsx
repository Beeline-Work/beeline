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
  get('tool-run-group-read').click(); await pause();
  get('tool-run-group-read').click(); await pause();
  assert(get('tool-run-more-read')?.textContent?.trim() === '2 more', 'reopened long list needs 2 more');
  assert(!get('tool-ledger-line-edit'), 'reopened list must cap at two');
  assert(get('tool-run-container-read').querySelectorAll('[data-testid^="tool-ledger-line-"]').length === 2, 'expanded long list must show exactly two children');
  const bordered = (id: string) => [get(id), ...get(id).querySelectorAll('*')].some(node => parseFloat(getComputedStyle(node).borderTopWidth) > 0);
  for (const id of ['tool-ledger-line-read', `notification-run-cell-${repositoryId}`, 'notification-run-cell-check', 'notification-run-cell-pay-1', 'notification-run-cell-notice-1', 'notification-run-cell-single-check', 'corner-status-line']) {
    assert(!bordered(id), `${id}: first or standalone row has an upper boundary`);
  }
  for (const id of ['tool-ledger-line-test', 'notification-run-cell-check-2', 'notification-run-cell-pay-2', 'notification-run-cell-notice-2']) {
    assert(bordered(id), `${id}: missing sibling separator`);
  }
  const repositoryChildren = get(`notification-run-${repositoryId}`).querySelectorAll('[data-testid^="notification-run-cell-"]');
  const merged = [...repositoryChildren].find(node => node.getAttribute('data-testid')?.startsWith('notification-run-cell-') && node.textContent?.includes('Merged') && !node.getAttribute('data-testid')?.includes('-corner-'))!;
  assert(merged && bordered(merged.getAttribute('data-testid')!), 'repository siblings need the same separator');
  const groups = ['tool-run-container-read', `notification-run-${repositoryId}`, 'notification-run-checks', 'notification-run-payments', 'notification-run-notices', 'inline-output'];
  for (const id of groups) {
    const style = getComputedStyle(get(id));
    assert(style.marginTop === '8px' && style.marginBottom === '8px', `${id}: unequal group spacing`);
  }
  for (const [previous, next] of [[`notification-run-${repositoryId}`, 'notification-run-checks'], ['notification-run-checks', 'notification-run-payments'], ['notification-run-payments', 'notification-run-notices'], ['notification-run-notices', 'inline-output']]) {
    assert(Math.abs(get(next).getBoundingClientRect().top - get(previous).getBoundingClientRect().bottom - 16) < 1, `${next}: leftover group gap`);
  }
  const number = [...document.querySelectorAll('[role="link"]')].find(node => node.textContent === 'PR 2721')!;
  assert(number, 'PR link missing');
  assert(number.getBoundingClientRect().height < 30, 'PR link wrapped');
  for (const node of document.querySelectorAll('[dir="auto"]')) {
    if (getComputedStyle(node).textDecorationLine.includes('underline')) {
      assert(node.textContent === node.textContent?.trim(), 'underlined link contains surrounding spaces');
    }
  }
  const arrowX = (id: string) => {
    const arrows = get(id).querySelectorAll('svg');
    const box = arrows[arrows.length - 1].getBoundingClientRect();
    return box.left + box.width / 2;
  };
  assert(Math.abs(arrowX('corner-status-line') - arrowX('notification-run-cell-check')) < 1, 'status chevron column differs');
  assert(Math.abs(get('corner-status-line').getBoundingClientRect().left - get('notification-run-cell-check').getBoundingClientRect().left) < 1, 'status left edge differs');
  const card = get('script-card').getBoundingClientRect();
  assert(card.bottom - get('script').getBoundingClientRect().bottom >= 16, 'script has no bottom padding');
  document.getElementById('result')!.textContent =
    `PASS DISCLOSURE-EDGE: ${before ? 'original edge' : 'no edge'}, 44px targets, edge taps expand/collapse, next-message spacing`;
}
main().catch((error) => {
  document.getElementById('result')!.textContent = `FAIL: ${error.message}`;
});
