import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { validateSavedWorkflow } from '@beeline/api-contract/daemon';
import { WELCOME_VIDEO_CONTRACT } from './welcome-video-workflow.js';

it('ships the documented, valid contract without owner-specific signup identities', async () => {
  const documented = JSON.parse(await readFile(new URL('../../../docs/workflows/welcome-video.json', import.meta.url), 'utf8'));
  expect(WELCOME_VIDEO_CONTRACT).toEqual(documented);
  expect(validateSavedWorkflow(documented)).toBeNull();
  expect(JSON.stringify(documented)).not.toMatch(/lunchboxfortwo|Bento Maker|1280&height=720/);
  expect(documented.handoffs.edit.hint).toContain('9:16');
  expect(documented.handoffs.check_film.hint).toContain('actually play');
  expect(documented.handoffs.show_preview.on.shown).toBe('done');
});
