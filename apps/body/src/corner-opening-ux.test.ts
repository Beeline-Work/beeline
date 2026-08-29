import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('corner opening feedback', () => {
  it('acknowledges immediately, then publishes preparing before workspace setup and active after it', () => {
    const source = readFileSync(new URL('./body.ts', import.meta.url), 'utf8');
    const openStart = source.indexOf('  async openSubchannel(');
    const openEnd = source.indexOf('\n  private async ', openStart + 1);
    const method = source.slice(openStart, openEnd);

    const acknowledgement = method.indexOf("'Opening a corner - preparing the workspace...'");
    const metadataTurn = method.indexOf('const conversation = await this.agentHistory');
    const preparingState = method.indexOf("cornerId: subchannelId,\n      state: 'open'");
    const worktree = method.indexOf('await this.createWorktree(');
    const activeState = method.indexOf("await this.transitionCornerState(info, 'working')");

    expect(acknowledgement).toBeGreaterThanOrEqual(0);
    expect(acknowledgement).toBeLessThan(metadataTurn);
    expect(preparingState).toBeGreaterThanOrEqual(0);
    expect(preparingState).toBeLessThan(worktree);
    expect(activeState).toBeGreaterThan(worktree);
  });
});
