import React from 'react';
// @ts-expect-error Standalone browser proof uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { LedgerSystemLine } from '../sources/components/buzz/Ledger';
import {
  classifyTurnSilence,
  phraseTurnSilence,
} from '../../../packages/api-contract/src/turn-silence';

const raw =
  'runtime_exited: ACP agent /nvm/bin/codex-acp exited code=127: env: node: No such file or directory';
const phrase = phraseTurnSilence('@codex', classifyTurnSilence(raw, 'hiccup'), { givingUp: true });
const text = `@codex ${phrase.verb} · ${phrase.consequence}`;
createRoot(document.getElementById('root')!).render(
  <LedgerSystemLine id="harness-failure" text={text} stamp="now" />,
);
setTimeout(() => {
  const row = document.querySelector('[data-testid="system-line-text-harness-failure"]');
  const toggle = document.querySelector(
    '[data-testid="system-line-toggle-harness-failure"]',
  ) as HTMLElement | null;
  toggle?.click();
  setTimeout(() => {
    const visible = row?.textContent ?? '';
    if (
      !visible.includes("background service can't find Node") ||
      !visible.includes('beeline connect') ||
      visible.includes('runtime_exited')
    ) {
      document.getElementById('result')!.textContent = `FAIL: ${visible}`;
      return;
    }
    document.getElementById('result')!.textContent =
      `PASS: harness-node-missing-path Room failure renders: ${visible}`;
  }, 300);
}, 300);
