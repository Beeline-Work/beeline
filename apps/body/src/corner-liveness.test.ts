import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { workingInvariantAlarm } from './corner-liveness.js';

const BODY_SOURCE = readFileSync(new URL('./body.ts', import.meta.url), 'utf8');

function method(name: string, next: string): string {
  return BODY_SOURCE.slice(BODY_SOURCE.indexOf(name), BODY_SOURCE.indexOf(next));
}

describe('corner no-agency boundary', () => {
  it('7. never-idle blocker loop alarms with evidence and makes zero model calls or transcript prose', () => {
    const alarm = workingInvariantAlarm({
      cornerId: 'corner-dark',
      requestId: 'request-1',
      lastReceipt: 'complete',
      queuedDelivery: 'none',
      sessionHealth: 'alive',
      processHealth: 'idle',
      relayCursor: 42,
      gitTip: 'a'.repeat(40),
    });
    expect(alarm.message).toContain('corner=corner-dark request=request-1');
    expect(alarm.message).toContain('receipt=complete queued=none');
    expect(alarm.message).toContain('session=alive process=idle');
    const watch = method('private async pollConcludeWatch', 'private async pollRoomMaintenance');
    expect(watch).not.toContain('promptAgent(');
    expect(watch).not.toContain('postAgentMessage(');
    expect(watch).not.toContain('buildControlMessage(');
  });

  it('6. target motion and ordinary maintenance never create hidden feedback model turns', () => {
    const maintenance = method('private async pollRoomMaintenance', 'async assertRepositorySafety');
    const gitWatch = method('private async pollCornerCommitWatch', 'private async noteCommitWatchFailure');
    expect(maintenance).not.toContain('promptAgent(');
    expect(gitWatch).not.toContain('promptAgent(');
    expect(BODY_SOURCE).not.toContain("cause: 'corner-conclude'");
    expect(BODY_SOURCE).not.toContain("cause: 'corner-metadata'");
  });
});
