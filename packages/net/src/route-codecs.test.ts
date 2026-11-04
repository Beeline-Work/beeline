import { describe, expect, it } from 'vitest';
import { routes } from './routes.js';
import { operationShapes, wireShapes } from './generated-wire-shapes.js';
import { jsonCodec } from './wire-codec.js';

describe('contract-derived operation codecs', () => {
  it('covers every phone and daemon leaf without a permissive fallback', () => {
    expect(Object.keys(operationShapes).sort()).toEqual(Object.keys(routes).sort());
    for (const route of Object.values(routes)) {
      expect(typeof route.params.parse).toBe('function');
      expect(typeof route.result.parse).toBe('function');
      expect(route.compatibility).toBe('legacy-only');
    }
  });

  it('validates actual read parameters and results, including missing required fields', () => {
    expect(routes['phone.countNeedsYou'].params.parse({ workspaceId: 'w' })).toEqual({ workspaceId: 'w' });
    for (const invalid of [null, [], {}, { workspaceId: 42 }])
      expect(() => routes['phone.countNeedsYou'].params.parse(invalid)).toThrow();
    expect(routes['phone.countNeedsYou'].result.parse({ count: 2 })).toEqual({ count: 2 });
    expect(() => routes['phone.countNeedsYou'].result.parse({ count: '2' })).toThrow();
    expect(() => routes['phone.readRoom'].result.parse({ room: { id: 'r' } })).toThrow();
  });

  it('preserves the documented binary upload exception outside JSON socket inputs', () => {
    const route = routes['phone.uploadMedia'];
    expect(route.transport).toBe('file-bytes');
    expect(route.exception).toMatchObject({ id: 'file-bytes',
      existingSite: 'apps/mobile/sources/sync/transport/monolith-rig-transport.ts::session-fetch' });
    expect(operationShapes['phone.uploadMedia'].input).toBe('file-bytes');
    const upload = { bytes: new Uint8Array([1, 2]), mimeType: 'image/png', name: 'sample.png' };
    expect(route.params.parse(upload)).toEqual(upload);
    for (const invalid of [{ bytes: [1, 2], mimeType: 'image/png' }, { bytes: upload.bytes, mimeType: 4 },
      { bytes: upload.bytes, mimeType: 'image/png', pass: {} },
      { bytes: new Uint8Array(25 * 1024 * 1024 + 1), mimeType: 'image/png' }])
      expect(() => route.params.parse(invalid)).toThrow();
    expect(route.result.parse({ name: 'sample.png', url: '/media/f', mimeType: 'image/png', size: 2, sha256: 'a' })).toBeTruthy();
  });

  it('decodes void replies as the explicit null sent by the dispatcher', () => {
    expect(routes['phone.markRead'].result.parse(null)).toBeNull();
    for (const invalid of [undefined, {}, false]) expect(() => routes['phone.markRead'].result.parse(invalid)).toThrow();
  });

  it('validates intersections, unions, enums and nested optional arrays', () => {
    const send = routes['phone.sendRoomMessage'].params;
    expect(send.parse({ roomId: 'r', text: 'Hello', mentions: ['ada'], attachments: undefined })).toBeTruthy();
    for (const invalid of [{ text: 'Hello' }, { roomId: 'r', text: 2 }, { roomId: 'r', text: 'Hello', mentions: [2] }])
      expect(() => send.parse(invalid)).toThrow();
    const add = routes['phone.addRoomMember'].params;
    expect(add.parse({ roomId: 'r', memberId: 'ada' })).toBeTruthy();
    expect(add.parse({ roomId: 'r', memberIds: ['ada'] })).toBeTruthy();
    expect(() => add.parse({ roomId: 'r', memberId: 'ada', memberIds: ['ada'] })).toThrow();
  });

  it('bounds bytes and structural work and never invokes accessors', () => {
    const codec = routes['phone.sendRoomMessage'].params;
    expect(() => codec.parse({ roomId: 'r', text: 'x'.repeat(65536) })).toThrow('byte limit');
    expect(() => codec.parse({ roomId: 'r', text: '😀'.repeat(20000) })).toThrow('byte limit');
    let called = false;
    const accessor = { roomId: 'r', get text() { called = true; return 'secret'; } };
    expect(() => codec.parse(accessor)).toThrow('accessor');
    const hidden = Object.defineProperty({ roomId: 'r' }, 'text', { get() { called = true; return 'secret'; } });
    expect(() => codec.parse(hidden)).toThrow('accessor');
    expect(called).toBe(false);
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(() => codec.parse(cycle)).toThrow('cyclic');
    expect(() => routes['phone.countNeedsYou'].result.parse({ count: Infinity })).toThrow('non-JSON');
  });

  it('keeps template literals constrained without unbounded regular expressions', () => {
    const numeric = wireShapes.findIndex(shape => shape.kind === 'template' && shape.slots[0] === 'number');
    const codec = jsonCodec(wireShapes, numeric, 1024);
    expect(codec.parse('batch:23')).toBe('batch:23');
    for (const invalid of ['batch:', 'batch: ', 'batch:NaN', 'batch:Infinity', 'other:23']) expect(() => codec.parse(invalid)).toThrow();
  });
});
