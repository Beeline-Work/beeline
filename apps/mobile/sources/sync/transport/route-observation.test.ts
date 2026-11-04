import { expect, it } from 'vitest';
import { RouteObservation } from './route-observation';

it('keeps only bounded closed-literal observations, never payload or arbitrary operation text', () => {
  const observer = new RouteObservation();
  for (let i = 0; i < 250; i++) observer.observe('countNeedsYou', { workspaceId: 'secret' });
  expect(observer.snapshot()).toHaveLength(100);
  expect(JSON.stringify(observer.snapshot()).length).toBeLessThan(16 * 1024);
  observer.observe('secret-unknown-operation', { secret: true });
  expect(observer.snapshot().at(-1)).toEqual({ route: 'undeclared', verdict: 'undeclared' });
  expect(JSON.stringify(observer.snapshot())).not.toContain('secret');
  observer.observe('uploadMedia', { bytes: new Uint8Array([1]), mimeType: 'image/png' });
  expect(observer.snapshot().at(-1)).toEqual({ route: 'phone.uploadMedia', verdict: 'wrong-transport' });
  observer.clear();
  expect(observer.snapshot()).toEqual([]);
});
