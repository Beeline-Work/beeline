import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Retired corners explainer tombstone contract: these deleted copy and style
 * names must not return to the transport-owning screen. Header and row
 * presentation are exercised by the rendered RoomCornersList suite.
 */
const screenSource = readFileSync(path.join(__dirname, '[roomId].tsx'), 'utf8');

describe('retired corners explainer tombstone contract', () => {
  it('keeps the retired explainer deleted', () => {
    for (const retired of [
      'YOLO INSIDE',
      'modelPanel',
      'modelTitle',
      'modelText',
      'GITHUB IS THE LIFECYCLE',
    ]) {
      expect(screenSource, `${retired} should stay retired`).not.toContain(retired);
    }
  });
});
