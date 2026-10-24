import React from 'react';
// @ts-expect-error Standalone proof uses installed react-dom.
import { createRoot } from 'react-dom/client';
import { DisclosureRowsProof, SystemRowsProof, repositoryId } from './disclosure-rows-proof';

createRoot(document.getElementById('root')!).render(location.search.includes('system') ? <SystemRowsProof /> : <DisclosureRowsProof />);
const pause = () => new Promise((resolve) => setTimeout(resolve, 80));
const get = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
const assert = (ok: unknown, why: string) => {
  if (!ok) throw Error(why);
};
async function main() {
  await document.fonts.ready;
  await pause();
  if (location.search.includes('system')) return systemRows();
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
    assert(style.marginTop === '0px' && style.marginBottom === '0px', `${id}: unequal group spacing`);
  }
  for (const [previous, next] of [[`notification-run-${repositoryId}`, 'notification-run-checks'], ['notification-run-checks', 'notification-run-payments'], ['notification-run-payments', 'notification-run-notices'], ['notification-run-notices', 'inline-output']]) {
    assert(Math.abs(get(next).getBoundingClientRect().top - get(previous).getBoundingClientRect().bottom) < 1, `${next}: leftover group gap`);
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
  // Repository reference rows retain body; summaries and check children use meta (Reproduction R1).
  for (const [summary, ids] of [['notification-run-expand-checks', ['notification-run-cell-check', 'notification-run-cell-check-2']], [`notification-run-expand-${repositoryId}`, [merged.getAttribute('data-testid')!]]] as const) {
    const label = getComputedStyle(get(summary).querySelector('[dir="auto"]')!);
    assert(label.fontSize === '13px', `${summary}: label is ${label.fontSize}`);
    for (const id of ids)
      for (const node of get(id).querySelectorAll('[dir="auto"]')) {
        const style = getComputedStyle(node);
        const expectedSize = summary === `notification-run-expand-${repositoryId}` ? '16px' : label.fontSize;
        assert(style.fontSize === expectedSize, `${id}: expected ${expectedSize}, got ${style.fontSize}`);
        assert(style.fontFamily.includes('SpaceGrotesk'), `${id}: row font ${style.fontFamily}`);
      }
  }
  assert(!document.querySelector('[data-testid^="notification-run-cell-corner-check"]'), 'corner check links back to its own corner');
  const card = get('script-card').getBoundingClientRect();
  assert(getComputedStyle(get('script')).marginBottom === '0px', 'script body margin differs from main');
  assert(Math.abs(card.height - 147) < 1, 'open script card height differs from main');
  document.getElementById('result')!.textContent =
    `PASS DISCLOSURE-EDGE: ${before ? 'original edge' : 'no edge'}, 44px targets, edge taps expand/collapse, next-message spacing`;
}
main().catch((error) => {
  document.getElementById('result')!.textContent = `FAIL: ${error.message}`;
});

async function systemRows() {
  const baseline = location.search.includes('baseline');
  const short = get('system-line-short-proof').getBoundingClientRect();
  const shortText = get('system-line-text-short-proof').getBoundingClientRect();
  const metrics = {
    x: short.x,
    y: short.y,
    height: short.height,
    textX: shortText.x,
    textY: shortText.y,
  };
  assert(!get('system-line-toggle-short-proof'), 'short row gained a chevron');
  for (const id of ['long-proof', 'link-proof']) {
    const control = () => get(`system-line-toggle-${id}`);
    const text = () => get(`system-line-text-${id}`);
    assert(control(), `${id}: no disclosure`);
    const checkAlignment = () => {
      const mark = control().querySelector('svg')!.getBoundingClientRect();
      const box = text().getBoundingClientRect();
      const centre = mark.y + mark.height / 2;
      const onFirstLine =
        centre >= box.y && centre <= box.y + parseFloat(getComputedStyle(text()).lineHeight);
      assert(baseline ? !onFirstLine : onFirstLine, `${id}: chevron is not on first line`);
      if (!baseline) {
        assert(control().contains(text()), `${id}: separate chevron-only row`);
        assert(
          Math.abs(box.x - control().getBoundingClientRect().x - 22) < 1,
          `${id}: wrong text indent`,
        );
      }
      assert(control().getBoundingClientRect().height >= 44, `${id}: tap height`);
    };
    checkAlignment();
    assert(getComputedStyle(text()).webkitLineClamp === '2', `${id}: not clamped`);
    const measuredWidth = get(`system-line-measurement-${id}`).getBoundingClientRect().width;
    if (!baseline)
      assert(
        Math.abs(measuredWidth - control().getBoundingClientRect().width) < 1,
        `${id}: measurement lost full width`,
      );
    const closedHeight = text().getBoundingClientRect().height;
    const closedText = text().textContent;
    if (baseline) control().click();
    else {
      const box = control().getBoundingClientRect();
      document
        .elementFromPoint(box.right - 2, box.top + 2)!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
    await pause();
    assert(text().textContent === closedText, `${id}: original text changed`);
    assert(text().getBoundingClientRect().height > closedHeight, `${id}: did not expand`);
    assert(control().getAttribute('aria-expanded') === 'true', `${id}: expanded state`);
    assert(
      control().querySelector('polyline')?.getAttribute('points') === '6 9 12 15 18 9',
      `${id}: down chevron`,
    );
    checkAlignment();
    control().click();
    await pause();
    const target = get(
      id === 'long-proof' ? 'system-line-name-long-proof-0' : 'system-line-object-link-proof',
    );
    target.click();
    await pause();
    assert(
      get('system-proof-action').textContent ===
        (id === 'long-proof' ? 'Identity: scheduler' : 'URL: https://example.test/receipt'),
      `${id}: nested action lost`,
    );
    assert(control().getAttribute('aria-expanded') === 'false', `${id}: nested action toggled row`);
    assert(
      control().querySelector('polyline')?.getAttribute('points') === '9 6 15 12 9 18',
      `${id}: right chevron`,
    );
    assert(
      get(`system-line-measurement-${id}`).getBoundingClientRect().width === measuredWidth,
      `${id}: measurement width changed`,
    );
    if (location.search.includes('opened')) {
      control().click();
      await pause();
    }
  }
  document.getElementById('result')!.textContent =
    `PASS SYSTEM-FIRST-LINE ${JSON.stringify(metrics)}`;
}
