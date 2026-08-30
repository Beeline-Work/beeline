import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('corner opening feedback', () => {
  it('publishes only the durable created fact and live session fact', () => {
    const source = readFileSync(new URL('./body.ts', import.meta.url), 'utf8');
    const openStart = source.indexOf('  async openSubchannel(');
    const openEnd = source.indexOf('\n  private async ', openStart + 1);
    const method = source.slice(openStart, openEnd);

    const acknowledgement = method.indexOf("'Opening a corner - preparing the workspace...'");
    const createdFact = method.indexOf("'corner-created'");
    const liveFact = method.indexOf("'corner-session-live'");

    expect(acknowledgement).toBe(-1);
    expect(createdFact).toBeGreaterThanOrEqual(0);
    expect(liveFact).toBeGreaterThan(createdFact);
  });
});
