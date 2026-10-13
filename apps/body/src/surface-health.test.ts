import { describe, expect, it } from 'vitest';
import { ThinDaemonCore } from './thin-core.js';
import { RoomRuntimeCoordinator } from './room-runtime.js';
import { SurfaceHealth } from './surface-health.js';

describe('surface health', () => {
  it('reports healthy discovery while idle surfaces have not subscribed and no surface failed', () => {
    const health = new SurfaceHealth();
    health.discover('serving', 'room');
    health.subscribed('serving', true);
    health.intakeReady('serving');
    health.discover('idle', 'corner');
    const runtime = Object.assign(Object.create(RoomRuntimeCoordinator.prototype), { surfaceHealth: health });
    const core = Object.assign(Object.create(ThinDaemonCore.prototype), { roomRuntime: runtime, discoveryStatus: '' });
    runtime.activeRoomCount = () => 1;
    expect(core.healthStatus()).toBe('healthy; 1 Room active; surfaces=2 intake-ready=1 subscribed=0 discovered=1 degraded=0');
    health.degraded('idle', 'intake failed');
    expect(core.healthStatus()).toMatch(/^degraded;/);
  });

  it('keeps a broken corner separate from a serving Room and recovers on subscription', () => {
    const health = new SurfaceHealth();
    health.discover('room-a', 'room');
    health.discover('corner-b', 'corner');
    expect(health.hasUnready()).toBe(true);
    health.intakeReady('room-a');
    health.subscribed('room-a', true);
    health.degraded('corner-b', 'repository unavailable');

    expect(health.snapshot()).toEqual([
      { id: 'corner-b', kind: 'corner', stage: 'degraded', reason: 'repository unavailable' },
      { id: 'room-a', kind: 'room', stage: 'intake-ready' },
    ]);
    expect(health.hasDegraded()).toBe(true);
    expect(health.summary()).toContain('intake-ready=1');

    health.intakeReady('corner-b');
    health.subscribed('corner-b', true);
    expect(health.snapshot()[0]).toEqual({ id: 'corner-b', kind: 'corner', stage: 'intake-ready' });
    expect(health.hasDegraded()).toBe(false);
    expect(health.hasUnready()).toBe(false);

    health.subscribed('room-a', false);
    expect(health.snapshot()[1]).toMatchObject({
      id: 'room-a',
      stage: 'degraded',
      reason: 'live subscription disconnected',
    });
    health.subscribed('room-a', true);
    expect(health.snapshot()[1]?.stage).toBe('intake-ready');
    health.retain(new Set(['room-a']));
    expect(health.snapshot().map((surface) => surface.id)).toEqual(['room-a']);
  });
});
