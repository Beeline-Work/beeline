import React from 'react';
// @ts-expect-error Standalone proof uses installed react-dom.
import { createRoot } from 'react-dom/client';
import { MemberSheetsProof, candidates } from './member-sheets-fixture';
const pause = () => new Promise((resolve) => setTimeout(resolve, 250));
const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};
async function run() {
  document.getElementById('root')!.style.height = '100vh';
  createRoot(document.getElementById('root')!).render(<MemberSheetsProof />);
  await pause();
  byId('open-roster').click();
  await pause();
  const roster = byId('room-roster-sheet');
  assert(roster, 'Roster paints');
  assert(!byId('room-roster-members-head'), 'Orphan count head must be absent');
  assert(!roster.textContent?.includes('Default'), 'Placeholder model must be hidden');
  for (const name of ['6 Astra', '6.1 Sol', 'deepseek-v4.1-flash'])
    assert(roster.textContent?.includes(name), `Real model ${name}`);
  const add = byId('room-roster-add-members');
  assert(add?.getAttribute('aria-label') === 'Add members' && Boolean(add.querySelector('svg')), 'Manager has shared plus action');
  const close = roster.querySelector<HTMLElement>('[aria-label="Close Room roster"]')!;
  assert(add.parentElement === close.parentElement, 'Add and Close share heading');
  add.click();
  await pause();
  const row = byId(`member-picker-candidate-${candidates[0].pubkey}`);
  assert(
    getComputedStyle(row).paddingLeft === '24px' && getComputedStyle(row).paddingRight === '24px',
    'Candidate uses sheet inset',
  );
  for (const id of ['room-member-picker-invite-person', 'room-member-picker-add-agent']) {
    assert(getComputedStyle(byId(id)).paddingLeft === '24px', `${id} aligned with candidates`);
  }
  row.click();
  await pause();
  byId('member-picker-add').click();
  await pause();
  assert(byId('fixture-result').textContent === 'Added candidate-0', 'Selected candidate added');
  byId('toggle-empty').click();
  byId('open-roster').click();
  await pause();
  byId('room-roster-add-members').click();
  await pause();
  assert(byId('member-picker-sheet'), 'Empty Room reaches picker');
  document.querySelector<HTMLElement>('[aria-label="Close member picker"]')!.click();
  await pause();
  byId('toggle-manager').click();
  byId('toggle-empty').click();
  byId('open-roster').click();
  await pause();
  assert(!byId('room-roster-add-members'), 'Viewer has no Add');
  document.getElementById('result')!.textContent =
    'PASS roster heading, model names, permissions, empty Room, picker insets and selection';
}
run().catch((error) => {
  document.getElementById('result')!.textContent = `FAIL ${error.message}`;
});
