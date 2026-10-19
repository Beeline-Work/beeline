import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { readRoomViewMessage } from '@beeline/api-contract/phone';
import { displayRoomMessage } from '../sources/buzz/room-view-presentation';
import { AgentCommandCard } from '../sources/app/(app)/beeline/chat/RoomMessageVariants';

/**
 * A corner reader sees an agent's report as one collapsed record card, and a
 * tap on its header shows the full text in place. The row is the shape the
 * server's readRoom returns for an `agent-command` card.
 */
const text =
  'needs-decision: PR #2599 is ready for review\nChecks are green on the exact head.\nShould I merge it now?';
const row = {
  id: 'f'.repeat(64),
  text: '@jellybean reported to @ruby · needs-decision',
  createdAt: 1_760_000_000,
  author: { pubkey: 'a'.repeat(64), kind: 'agent', name: 'Jellybean', handle: 'jellybean' },
  presentation: 'card',
  agentCommand: {
    kind: 'report',
    recipient: { id: 'b'.repeat(64), name: 'Ruby', handle: 'ruby' },
    status: 'needs-decision',
    text,
  },
};

const pause = () => new Promise((resolve) => setTimeout(resolve, 200));
const report = (value: string) => {
  document.getElementById('result')!.textContent = value;
};

async function run() {
  const parsed = readRoomViewMessage(row);
  if (!parsed?.agentCommand) return report('FAIL the contract guard dropped the agentCommand card');
  const message = displayRoomMessage(parsed, 'c'.repeat(64));
  const root = document.getElementById('root')!;
  // The Obsidian canvas, so the card paints on the ground it ships on.
  document.body.style.background = '#14091A';
  root.style.cssText = 'padding:16px;width:360px';
  createRoot(root).render(<AgentCommandCard message={message} stamp="2m" />);
  await pause();
  const page = () => document.body.innerText;
  if (!page().includes('Jellybean → Ruby · needs-decision')) return report(`FAIL title: ${page()}`);
  if (page().includes('Should I merge it now?'))
    return report('FAIL collapsed card shows the full text');
  const header = document.querySelector<HTMLElement>('[data-testid="agent-command-header"]');
  if (!header) return report('FAIL no header');
  if (new URLSearchParams(location.search).has('expanded')) {
    header.click();
    await pause();
    if (!page().includes('Should I merge it now?'))
      return report('FAIL tap did not show the full text');
    header.click();
    await pause();
    if (page().includes('Should I merge it now?'))
      return report('FAIL second tap did not collapse');
    header.click();
    await pause();
  }
  report('PASS');
}

run().catch((error) => report(String(error)));
