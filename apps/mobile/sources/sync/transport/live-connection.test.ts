import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import InternetReachability from '@react-native-community/netinfo/src/internal/internetReachability';

const appStateListeners = vi.hoisted(() => new Set<(state: string) => void>());
const nativeModules = vi.hoisted(() => ({ RNCNetInfo: {} as object | null }));
const netInfoImport = vi.hoisted(() => vi.fn());
const netInfo = vi.hoisted(() => ({
  configure: vi.fn(),
  addEventListener: vi.fn((_listener: () => void) => vi.fn()),
}));
vi.mock('react-native', () => ({
  NativeModules: nativeModules,
  Platform: { OS: 'android' },
  AppState: {
    currentState: 'active',
    addEventListener: (_event: string, listener: (state: string) => void) => {
      appStateListeners.add(listener);
      return { remove: () => appStateListeners.delete(listener) };
    },
  },
}));
vi.mock('@react-native-community/netinfo', () => {
  netInfoImport();
  return { default: netInfo };
});

vi.mock('@/buzz/router-owner', () => ({
  routerOwnerCapabilities: () => ({
    families: ['room-list', 'needs-you-count', 'room-head'],
    authorityFencesV1: true,
  }),
  routerOwnerNegotiated: async () => {},
  routerOwnerDisconnected: () => {},
  routerOwnerReceive: () => {},
}));

import { AppState } from 'react-native';
import { LiveConnection, resetSharedLiveConnection, sharedLiveConnection } from './live-connection';
import {
  MonolithSession,
  MonolithRequestTimeoutError,
  monolithSession,
} from '@/auth/monolith-session';
import { liveFrameEpoch } from './live-frame-epoch';
import { getRoomCornerSummary, getRoomCorners } from '@/buzz/room-corner-store';
import { resetClientState } from '@/sync/client-reset';

const ROOM_A = 'room-a';
const ROOM_B = 'room-b';

type TestSocket = {
  autoPong: boolean;
  sent: string[];
  closed: boolean;
  readyState: number;
  url: string;
  protocols: string[];
  open: () => void;
  emit: (data: unknown) => void;
  drop: () => void;
  error: () => void;
};

function stubSockets(): TestSocket[] {
  const sockets: TestSocket[] = [];
  class TestWebSocket {
    static readonly OPEN = 1;
    autoPong = true;
    sent: string[] = [];
    closed = false;
    readyState = 0;
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: () => void;
    onerror?: () => void;
    constructor(
      readonly url: string,
      readonly protocols: string[],
    ) {
      sockets.push(this as unknown as TestSocket);
    }
    send(value: string) {
      this.sent.push(value);
      if (value === '{"type":"ping"}' && this.autoPong) this.emit({ type: 'pong' });
    }
    close() {
      this.closed = true;
      this.readyState = 3;
    }
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
    emit(data: unknown) {
      this.onmessage?.({ data: JSON.stringify(data) });
    }
    drop() {
      this.readyState = 3;
      this.onclose?.();
    }
    error() {
      this.onerror?.();
    }
  }
  vi.stubGlobal('WebSocket', TestWebSocket);
  return sockets;
}

function createConnection(authorization = vi.fn().mockResolvedValue('phone-session')) {
  const identityListeners = new Set<() => void>();
  const networkListeners = new Set<() => void>();
  const connection = new LiveConnection({
    authorization,
    liveUrl: () => 'wss://server.example/v1/phone/live',
    subscribeIdentityChange: (listener) => {
      identityListeners.add(listener);
      return () => identityListeners.delete(listener);
    },
    subscribeNetworkChange: (listener) => {
      networkListeners.add(listener);
      return () => networkListeners.delete(listener);
    },
  });
  return {
    connection,
    authorization,
    changeIdentity: () => {
      for (const listener of identityListeners) listener();
    },
    foreground: () => {
      for (const listener of appStateListeners) listener('background');
      for (const listener of appStateListeners) listener('active');
    },
    networkChanged: () => {
      for (const listener of networkListeners) listener();
    },
  };
}

describe('LiveConnection', () => {
  let sockets: TestSocket[];

  beforeEach(() => {
    nativeModules.RNCNetInfo = {};
    appStateListeners.clear();
    AppState.currentState = 'active';
    sockets = stubSockets();
  });

  afterEach(() => {
    resetSharedLiveConnection();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    netInfo.configure.mockClear();
    netInfo.addEventListener.mockClear();
  });

  it('NETINFO-7821938592: Metro reports the installed import failure before catch', async () => {
    const reportFatalError = vi.fn();
    const runtime: Record<string, any> = {
      __DEV__: false,
      __METRO_GLOBAL_PREFIX__: '',
      console,
      ErrorUtils: { reportFatalError },
    };
    runtime.global = runtime;
    runInNewContext(
      readFileSync('node_modules/metro-runtime/src/polyfills/require.js', 'utf8'),
      runtime,
    );
    const source = readFileSync(
      'node_modules/@react-native-community/netinfo/src/internal/nativeInterface.ts',
      'utf8',
    );
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText;
    const nativeFactory = runInNewContext(`(function(require, module, exports) { ${compiled} })`);
    runtime.__d(
      (
        _global: unknown,
        _require: unknown,
        _default: unknown,
        _all: unknown,
        module: any,
        exports: any,
      ) => {
        nativeFactory(
          (name: string) => (name === 'react-native' ? {} : { default: null }),
          module,
          exports,
        );
      },
      1,
      [],
    );
    runtime.require = runtime.__r;
    runtime.module = { exports: {} };
    runInNewContext(
      readFileSync('node_modules/metro-runtime/src/modules/asyncRequire.js', 'utf8'),
      runtime,
    );
    await runtime.module.exports(1).catch(() => undefined);
    expect(reportFatalError).toHaveBeenCalledOnce();
    expect(reportFatalError.mock.calls[0]![0].message).toContain('NativeModule.RNCNetInfo is null');
  });

  it('NETINFO-7821938592: installed native interface rejects without RNCNetInfo', async () => {
    nativeModules.RNCNetInfo = null;
    await expect(
      import('@react-native-community/netinfo/src/internal/nativeInterface'),
    ).rejects.toThrow('NativeModule.RNCNetInfo is null');
  });

  it('NETINFO-7821938592: starts the shared socket without evaluating missing NetInfo', async () => {
    nativeModules.RNCNetInfo = null;
    netInfoImport.mockClear();
    vi.spyOn(monolithSession, 'authorization').mockResolvedValue('phone-session');
    const connection = sharedLiveConnection();
    const room = vi.fn();
    await connection.register([{ '#h': [ROOM_A] }], room);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.open();
    sockets[0]!.emit({ type: 'subscribed', roomId: ROOM_A });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(netInfoImport).not.toHaveBeenCalled();
    expect(netInfo.addEventListener).not.toHaveBeenCalled();
    expect(room).toHaveBeenCalledWith({ monolithLive: { type: 'subscribed', roomId: ROOM_A } });
  });

  it('disables NetInfo HTTP reachability before subscribing to native changes', async () => {
    sharedLiveConnection();
    await vi.waitFor(() => expect(netInfo.addEventListener).toHaveBeenCalledOnce());

    expect(netInfo.configure).toHaveBeenCalledBefore(netInfo.addEventListener);
    expect(netInfo.configure).toHaveBeenCalledWith({ reachabilityShouldRun: expect.any(Function) });
    expect(netInfo.configure.mock.calls[0]?.[0].reachabilityShouldRun()).toBe(false);
  });

  it('retains native network recovery and removes the subscription on disposal', async () => {
    const unsubscribe = vi.fn();
    netInfo.addEventListener.mockReturnValueOnce(unsubscribe);
    vi.spyOn(monolithSession, 'authorization').mockResolvedValue('phone-session');
    const connection = sharedLiveConnection();
    await connection.register([{ '#h': [ROOM_A] }], () => undefined);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.open();
    await vi.waitFor(() => expect(netInfo.addEventListener).toHaveBeenCalledOnce());
    const listener = netInfo.addEventListener.mock.calls[0]![0] as () => void;
    listener();
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.closed).toBe(false);
    sockets[0]!.drop();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    connection.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('does not attach a native listener after disposal during import', async () => {
    sharedLiveConnection().dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(netInfo.addEventListener).not.toHaveBeenCalled();
  });

  it('NetInfo fallback starts neither an HTTP probe nor a recurring timer when disabled', () => {
    vi.useFakeTimers();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const reachability = new InternetReachability(
      {
        reachabilityShouldRun: () => false,
      } as ConstructorParameters<typeof InternetReachability>[0],
      () => undefined,
    );

    (
      reachability as unknown as { _setExpectsConnection: (connected: boolean) => void }
    )._setExpectsConnection(true);

    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('excludes durable families before negotiation when authority storage is unavailable', async () => {
    let resolve!: (value: { families: readonly []; authorityFencesV1: false }) => void;
    const router = {
      requestedCapabilities: () =>
        new Promise<{ families: readonly []; authorityFencesV1: false }>((done) => {
          resolve = done;
        }),
      negotiated: vi.fn(async () => {}),
      disconnected: vi.fn(),
      receive: vi.fn(),
    };
    const connection = new LiveConnection({
      authorization: async () => 'token',
      liveUrl: () => 'wss://server.example/v1/phone/live',
      subscribeIdentityChange: () => () => {},
      router,
    });
    await connection.register([], () => {});
    expect(sockets).toHaveLength(0);
    resolve({ families: [], authorityFencesV1: false });
    await Promise.resolve();
    await Promise.resolve();
    sockets[0]!.open();
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({
      type: 'router-negotiate',
      protocol: 1,
      families: [],
      authorityFencesV1: false,
      usageCellV1: true,
    });
    connection.dispose();
  });

  it.each([true, false, undefined])(
    'requires an explicit Room continuity acknowledgement (%s)',
    async (capability) => {
      const router = {
        negotiated: vi.fn(async (_next: unknown) => {}),
        disconnected: vi.fn(),
        receive: vi.fn(),
      };
      const connection = new LiveConnection({
        authorization: async () => 'token',
        liveUrl: () => 'wss://server.example/v1/phone/live',
        subscribeIdentityChange: () => () => {},
        router,
      });
      await connection.register([], () => {});
      sockets[0]!.open();
      sockets[0]!.emit({
        type: 'router-capabilities',
        protocol: 1,
        families: ['room-head'],
        roomHeadContinuityV1: capability,
      });
      expect(router.negotiated.mock.calls[0]![0]).toMatchObject({
        roomHeadContinuityV1: capability === true,
      });
      connection.dispose();
    },
  );

  it('negotiates on the sole socket and holds pushes until the local owner is ready', async () => {
    let ready!: () => void;
    const router = {
      negotiated: vi.fn(
        (_next: unknown) =>
          new Promise<void>((resolve) => {
            ready = resolve;
          }),
      ),
      disconnected: vi.fn(),
      receive: vi.fn(),
    };
    const connection = new LiveConnection({
      authorization: async () => 'token',
      liveUrl: () => 'wss://server.example/v1/phone/live',
      subscribeIdentityChange: () => () => {},
      router,
    });
    await connection.register([], () => {});
    sockets[0]!.open();
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({
      type: 'router-negotiate',
      protocol: 1,
      families: ['room-list', 'needs-you-count', 'room-head'],
      authorityFencesV1: true,
      usageCellV1: true,
      roomHeadContinuityV1: true,
    });
    sockets[0]!.emit({ type: 'router-capabilities', protocol: 1, families: ['room-list'] });
    const frame = { kind: 'push-commit', batchId: 'batch' };
    sockets[0]!.emit(frame);
    const fence = { kind: 'authority-fence', scope: 'object', authorityScope: 'object:object' };
    sockets[0]!.emit(fence);
    expect(router.receive).not.toHaveBeenCalled();
    expect(router.negotiated.mock.calls[0]![0]).toMatchObject({
      generation: 1,
      families: ['room-list'],
    });
    ready();
    await Promise.resolve();
    expect(router.receive.mock.calls).toEqual([[frame], [fence]]);
    connection.dispose();
  });

  it('retains every large router frame while the phone owner finishes negotiation', async () => {
    let ready!: () => void;
    const router = { negotiated: vi.fn(() => new Promise<void>(resolve => { ready = resolve; })),
      disconnected: vi.fn(), receive: vi.fn() };
    const connection = new LiveConnection({ authorization: async () => 'token',
      liveUrl: () => 'wss://server.example/v1/phone/live', subscribeIdentityChange: () => () => {}, router });
    try {
      await connection.register([], () => {}); sockets[0]!.open();
      sockets[0]!.emit({ type: 'router-capabilities', protocol: 1, families: ['room-list'] });
      const frames = Array.from({ length: 40 }, (_, index) => ({ kind: 'push-part', batchId: 'large-workspace',
        partIndex: index, facts: [{ text: 'x'.repeat(40 * 1024) }] }));
      for (const frame of frames) sockets[0]!.emit(frame);
      expect(sockets[0]!.closed).toBe(false);
      expect(router.disconnected).not.toHaveBeenCalled();
      expect(router.receive).not.toHaveBeenCalled();
      ready(); await Promise.resolve();
      expect(router.receive.mock.calls).toEqual(frames.map(frame => [frame]));
      expect(sockets).toHaveLength(1);
    } finally { connection.dispose(); }
  });

  it('does not let a Workspace reply downgrade an in-flight router negotiation', async () => {
    const router = { negotiated: vi.fn(async (_next: unknown) => {}), disconnected: vi.fn(), receive: vi.fn() };
    const connection = new LiveConnection({ authorization: async () => 'token',
      liveUrl: () => 'wss://server.example/v1/phone/live', subscribeIdentityChange: () => () => {}, router });
    try {
      await connection.register([], () => {});
      const read = connection.request('readWorkspaces', {});
      sockets[0]!.open();
      const request = sockets[0]!.sent.map(frame => JSON.parse(frame)).find(frame => frame.op === 'readWorkspaces');
      sockets[0]!.emit({ t: 'res', id: request.id, ok: true, result: { workspaces: [] } });
      await expect(read).resolves.toEqual({ workspaces: [] });
      expect(router.negotiated).not.toHaveBeenCalled();
      sockets[0]!.emit({ type: 'router-capabilities', protocol: 1, families: ['room-list'], commandDedupV1: true });
      sockets[0]!.emit({ type: 'sync-ok' });
      await Promise.resolve();
      expect(router.negotiated).toHaveBeenCalledOnce();
      expect(router.negotiated.mock.calls[0]![0]).toMatchObject({ families: ['room-list'] });
      expect(connection.commandState()).toMatchObject({ ready: true, commandDedupV1: true });
    } finally { connection.dispose(); }
  });

  it.each([[true, true], [true, false], [false, true], [false, false]])('passes negotiated Tray families only with command=%s and authority=%s', async (commandDedupV1, authorityFencesV1) => {
    const router = { negotiated: vi.fn(async (_next: unknown) => {}), disconnected: vi.fn(), receive: vi.fn() };
    const connection = new LiveConnection({ authorization: async () => 'token',
      liveUrl: () => 'wss://server.example/v1/phone/live', subscribeIdentityChange: () => () => {}, router });
    try {
      await connection.register([], () => {}); sockets[0]!.open();
      sockets[0]!.emit({ type: 'router-capabilities', protocol: 1,
        families: ['needs-you-tray', 'needs-you-saved-page'], commandDedupV1, authorityFencesV1 });
      expect(router.negotiated.mock.calls[0]![0]).toMatchObject({ families: commandDedupV1 && authorityFencesV1 ? ['needs-you-tray', 'needs-you-saved-page'] : [] });
    } finally { connection.dispose(); }
  });

  it('selects legacy once from an old-server acknowledgement without a fallback timer', async () => {
    vi.useFakeTimers();
    const router = {
      negotiated: vi.fn(async (_next: unknown) => {}),
      disconnected: vi.fn(),
      receive: vi.fn(),
    };
    const connection = new LiveConnection({
      authorization: async () => 'token',
      liveUrl: () => 'wss://server.example/v1/phone/live',
      subscribeIdentityChange: () => () => {},
      router,
    });
    await connection.register([], () => {});
    sockets[0]!.open();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(router.negotiated).not.toHaveBeenCalled();
    sockets[0]!.emit({ type: 'sync-ok' });
    sockets[0]!.emit({ type: 'sync-ok' });
    expect(router.negotiated).toHaveBeenCalledTimes(1);
    expect(router.negotiated.mock.calls[0]![0]).toMatchObject({ families: [] });
    expect(vi.getTimerCount()).toBe(1);
    connection.dispose();
  });

  it.each([true, false])(
    'P10: old negotiated executors cannot send on a replacement socket (router=%s)',
    async (selected) => {
      type Negotiated = Parameters<
        NonNullable<ConstructorParameters<typeof LiveConnection>[0]['router']>['negotiated']
      >[0];
      const router = {
        negotiated: vi.fn(async (_next: Negotiated) => {}),
        disconnected: vi.fn(),
        receive: vi.fn(),
      };
      const connection = new LiveConnection({
        authorization: async () => 'token',
        liveUrl: () => 'wss://server.example/v1/phone/live',
        subscribeIdentityChange: () => () => {},
        router,
      });
      try {
        await connection.register([], () => {});
        sockets[0]!.open();
        sockets[0]!.emit({
          type: 'router-capabilities',
          protocol: 1,
          families: ['room-list'],
          authorityFencesV1: true,
          mediaMetadataV1: true,
          usageCellV1: true,
        });
        await Promise.resolve();
        const old = router.negotiated.mock.calls[0]![0];
        sockets[0]!.drop();
        await vi.waitFor(() => expect(sockets).toHaveLength(2));
        sockets[1]!.open();
        sockets[1]!.emit(
          selected
            ? {
                type: 'router-capabilities',
                protocol: 1,
                families: ['room-list'],
                mediaMetadataV1: true,
              }
            : { type: 'sync-ok' },
        );
        await Promise.resolve();
        expect(router.negotiated.mock.calls[1]![0]).toMatchObject({
          generation: 2,
          families: selected ? ['room-list'] : [],
          mediaMetadataV1: selected,
        });
        const before = [...sockets[1]!.sent];
        const settled = [
          old.execute({ family: 'room-list', workspaceId: 'workspace' }),
          old.executeUsageCell!('agent'),
          old.executeMetadata!('object'),
          old.executeLink!('object'),
          old.executePlayback!('object'),
        ].map((promise) =>
          promise.then(
            () => 'resolved',
            () => 'rejected',
          ),
        );
        expect(sockets[1]!.sent).toEqual(before);
        expect(await Promise.all(settled)).toEqual(Array(5).fill('rejected'));
      } finally {
        connection.dispose();
      }
    },
  );


  it('requires negotiated command support and preserves durable identity independently of request ids', async () => {
    const router = { negotiated: vi.fn(async () => {}), disconnected: vi.fn(), receive: vi.fn() };
    const connection = new LiveConnection({
      authorization: async () => 'token',
      liveUrl: () => 'wss://server.example/v1/phone/live',
      subscribeIdentityChange: () => () => {},
      router,
    });
    await connection.register([], () => {});
    sockets[0]!.open();
    await expect(
      connection.requestCommand('markRead', { roomId: ROOM_A }, { v: 1, id: 'intent' }),
    ).rejects.toThrow();
    const changed = vi.fn();
    connection.subscribeCommandCapabilities(changed);
    sockets[0]!.emit({
      type: 'router-capabilities',
      protocol: 1,
      families: [],
      commandDedupV1: true,
    });
    await Promise.resolve();
    expect(connection.commandState()).toEqual({ generation: 1, commandDedupV1: true, ready: true });
    expect(changed).toHaveBeenCalledOnce();
    const pending = connection.requestCommand(
      'markRead',
      { roomId: ROOM_A },
      { v: 1, id: 'intent' },
    );
    const wire = JSON.parse(sockets[0]!.sent.at(-1)!);
    expect(wire).toMatchObject({
      t: 'req',
      op: 'markRead',
      args: { roomId: ROOM_A },
      command: { v: 1, id: 'intent' },
    });
    expect(wire.id).not.toBe('intent');
    const receipt = { v: 1, operation: 'markRead', commandId: 'intent', state: 'committed' };
    sockets[0]!.emit({ t: 'res', id: wire.id, ok: true, result: receipt });
    await expect(pending).resolves.toEqual(receipt);
    connection.dispose();
    expect(connection.commandState().commandDedupV1).toBe(false);
  });

  it('rejects projection reads outside the local owner before any network admission', async () => {
    const { connection } = createConnection();
    await expect(
      connection.request('readRouterSnapshot', { family: 'room-list', workspaceId: 'workspace' }),
    ).rejects.toThrow('local router owner');
    expect(sockets).toHaveLength(0);
    connection.dispose();
  });

  it('foreground idle sends one ping after 30 seconds and traffic resets its clock', async () => {
    vi.useFakeTimers();
    const { connection } = createConnection();
    await connection.register([], () => {}); sockets[0]!.open();
    const pings = () => sockets[0]!.sent.filter(frame => JSON.parse(frame).type === 'ping').length;
    await vi.advanceTimersByTimeAsync(29_999); expect(pings()).toBe(0);
    sockets[0]!.emit({ type: 'sync-ok' });
    await vi.advanceTimersByTimeAsync(29_999); expect(pings()).toBe(0);
    await vi.advanceTimersByTimeAsync(1); expect(pings()).toBe(1);
    expect(sockets).toHaveLength(1); expect(sockets[0]!.closed).toBe(false);
    connection.dispose(); expect(vi.getTimerCount()).toBe(0);
  });

  it('the foreground idle clock stops in background and its unanswered ping reconnects once', async () => {
    vi.useFakeTimers();
    const { connection } = createConnection();
    await connection.register([], () => {}); sockets[0]!.open();
    for (const listener of appStateListeners) listener('background');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets[0]!.sent.some(frame => JSON.parse(frame).type === 'ping')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    sockets[0]!.autoPong = false;
    for (const listener of appStateListeners) listener('active');
    sockets[0]!.emit({ type: 'pong' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sockets[0]!.sent.filter(frame => JSON.parse(frame).type === 'ping')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sockets[0]!.closed).toBe(true); expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(120_000); expect(sockets).toHaveLength(2);
    connection.dispose();
  });

  it('router frames waiting for readiness cannot replace the socket', async () => {
    let ready!: () => void;
    const router = { negotiated: vi.fn(() => new Promise<void>(resolve => { ready = resolve; })),
      disconnected: vi.fn(), receive: vi.fn() };
    const connection = new LiveConnection({ router, authorization: async () => 'token',
      liveUrl: () => 'wss://server.example/v1/phone/live', subscribeIdentityChange: () => () => {} });
    await connection.register([], () => {}); sockets[0]!.open();
    sockets[0]!.emit({ type: 'router-capabilities', protocol: 1, families: ['room-head'] });
    for (let i = 0; i < 40; i++) sockets[0]!.emit({ kind: 'router-unavailable', stream: 'workspace:w', families: ['room-head'], reason: 'listener' });
    expect(sockets[0]!.closed).toBe(false); expect(router.disconnected).not.toHaveBeenCalled();
    ready(); await vi.waitFor(() => expect(router.receive).toHaveBeenCalledTimes(40));
    expect(sockets).toHaveLength(1); connection.dispose();
  });

  it('a real socket replacement covers the visible Room while leaving other Rooms alone', async () => {
    vi.useFakeTimers();
    const { connection } = createConnection(); const first = vi.fn(), second = vi.fn();
    await connection.register([{ '#h': [ROOM_A] }], first);
    await connection.register([{ '#h': [ROOM_B] }], second);
    connection.view(ROOM_A); sockets[0]!.open();
    expect(first).not.toHaveBeenCalled();
    sockets[0]!.drop(); await vi.advanceTimersByTimeAsync(0); sockets[1]!.open();
    expect(first).toHaveBeenCalledExactlyOnceWith({ monolithLive: { type: 'invalidate', roomId: ROOM_A, reason: 'resync' } });
    expect(second).not.toHaveBeenCalled();
    connection.dispose();
  });

  it('a slow-reader recovery note refreshes only the named Room', async () => {
    const { connection } = createConnection(); const first = vi.fn(), second = vi.fn(), list = vi.fn();
    await connection.register([{ '#h': [ROOM_A] }], first);
    await connection.register([{ '#h': [ROOM_B] }], second);
    await connection.register([], list); sockets[0]!.open();
    sockets[0]!.emit({ type: 'missed-updates', roomIds: [ROOM_A], streams: [], workspace: false });
    expect(first).toHaveBeenCalledExactlyOnceWith({ monolithLive: { type: 'invalidate', roomId: ROOM_A, reason: 'resync' } });
    expect(second).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(1); connection.dispose();
  });

  it('a slow request with a live pong keeps waiting on the same socket', async () => {
    vi.useFakeTimers();
    const { connection } = createConnection();
    await connection.register([{ '#h': [ROOM_A] }], () => {});
    sockets[0]!.open();
    const pending = connection.request('readRoom', { roomId: ROOM_A }, { timeoutMs: 1_000 });
    const request = sockets[0]!.sent.map(frame => JSON.parse(frame)).find(frame => frame.t === 'req');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets[0]!.sent.filter(frame => JSON.parse(frame).type === 'ping')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.closed).toBe(false);
    sockets[0]!.emit({ t: 'res', id: request.id, ok: true, result: { room: ROOM_A } });
    await expect(pending).resolves.toEqual({ room: ROOM_A });
    connection.dispose();
  });

  it('an unanswered shared ping reconnects once and rejects only dispatched requests', async () => {
    vi.useFakeTimers();
    const { connection, foreground } = createConnection();
    await connection.register([{ '#h': [ROOM_A] }], () => {});
    sockets[0]!.open(); sockets[0]!.autoPong = false;
    const pending = connection.request('readRoom', { roomId: ROOM_A }, { timeoutMs: 1_000 }).catch(error => error);
    foreground();
    await vi.advanceTimersByTimeAsync(1_000);
    connection.reportRequestDeadlineMissed();
    expect(sockets[0]!.sent.filter(frame => JSON.parse(frame).type === 'ping')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(sockets[0]!.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).name).toBe('PhoneSocketDisconnectedError');
    expect(sockets[0]!.closed).toBe(true);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(2);
    connection.dispose();
  });

  it('data gaps and garbled previews re-read only the affected Room', async () => {
    const { connection } = createConnection();
    const first = vi.fn(), second = vi.fn();
    await connection.register([{ '#h': [ROOM_A] }], first);
    await connection.register([{ '#h': [ROOM_B] }], second);
    sockets[0]!.open();
    sockets[0]!.emit({ type: 'subscribed', roomId: ROOM_A, epoch: 'e', cursor: 1 });
    first.mockClear(); second.mockClear();
    sockets[0]!.emit({ type: 'invalidate', roomId: ROOM_A, epoch: 'e', sequence: 3, reason: 'message' });
    expect(first).toHaveBeenCalledExactlyOnceWith({ monolithLive: { type: 'invalidate', roomId: ROOM_A, reason: 'resync' } });
    expect(second).not.toHaveBeenCalled();
    first.mockClear();
    sockets[0]!.emit({ type: 'sidebar-preview', roomId: ROOM_A, preview: null });
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    first.mockClear();
    sockets[0]!.emit({ type: 'message-delta', roomId: ROOM_A, message: null });
    expect(first).toHaveBeenCalledExactlyOnceWith({ monolithLive: { type: 'invalidate', roomId: ROOM_A, reason: 'resync' } });
    expect(second).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(1); expect(sockets[0]!.closed).toBe(false);
    connection.dispose();
  });

  it('keeps the healthy shared socket when AppState returns to the foreground', async () => {
    vi.spyOn(monolithSession, 'authorization').mockResolvedValue('phone-session');
    const connection = sharedLiveConnection();
    await connection.register([{ '#h': [ROOM_A] }], () => undefined);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.open();
    for (const listener of appStateListeners) listener('background');
    for (const listener of appStateListeners) listener('active');
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.closed).toBe(false);
    connection.dispose();
  });

  it('NATIVE-142-BACKGROUND: leaves a healthy socket to Android beyond two minutes', async () => {
    vi.useFakeTimers();
    const { connection, foreground } = createConnection();
    await connection.register([{ '#h': [ROOM_A] }], () => {});
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.open();
    sockets[0]!.emit({ type: 'subscribed', roomId: ROOM_A, epoch: 'kept', cursor: 7 });
    const sent = [...sockets[0]!.sent];
    AppState.currentState = 'background';
    for (const listener of appStateListeners) listener('background');
    await vi.advanceTimersByTimeAsync(180_000);
    expect(sockets[0]!.closed).toBe(false);
    AppState.currentState = 'active';
    foreground();
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.sent).toEqual([...sent, JSON.stringify({ type: 'ping' })]);
    expect(vi.getTimerCount()).toBe(1);
    sockets[0]!.drop();
    await vi.advanceTimersByTimeAsync(0);
    sockets[1]!.open();
    expect(JSON.parse(sockets[1]!.sent[0]!)).toMatchObject({
      type: 'subscribe',
      cursors: { [ROOM_A]: { epoch: 'kept', base: 7, seen: [] } },
    });
    connection.dispose();
  });

  it('keeps a healthy background socket across native connectivity notifications', async () => {
    vi.useFakeTimers();
    const { connection, networkChanged } = createConnection();
    await connection.register([], () => {});
    sockets[0]!.open();
    AppState.currentState = 'background';
    for (const listener of appStateListeners) listener('background');
    networkChanged();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.closed).toBe(false);
    connection.dispose();
  });

  it('retries failed authorization once per recovery event without polling', async () => {
    vi.useFakeTimers();
    const authorization = vi.fn().mockRejectedValue(new Error('offline'));
    const { connection, networkChanged, foreground } = createConnection(authorization);
    await connection.register([{ '#h': [ROOM_A] }], () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(authorization).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(authorization).toHaveBeenCalledTimes(2);

    networkChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(authorization).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(authorization).toHaveBeenCalledTimes(4);

    foreground();
    await vi.advanceTimersByTimeAsync(0);
    expect(authorization).toHaveBeenCalledTimes(6);
    connection.reconnectNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(authorization).toHaveBeenCalledTimes(8);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(authorization).toHaveBeenCalledTimes(8);
    connection.dispose();
  });

  it('reopens once when an established socket errors, and not after a failed handshake', async () => {
    vi.useFakeTimers();
    const { connection } = createConnection();
    await connection.register([{ '#h': [ROOM_A] }], () => undefined);
    sockets[0]!.open();
    sockets[0]!.error();
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(2);
    expect(sockets[0]!.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.error();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(2);
    connection.dispose();
  });

  it('does not open another socket after a handshake error until an external event', async () => {
    vi.useFakeTimers();
    const { connection, networkChanged } = createConnection();
    await connection.register([{ '#h': [ROOM_A] }], () => undefined);
    expect(sockets).toHaveLength(1);

    sockets[0]!.error();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.closed).toBe(true);

    networkChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(2);
    sockets[1]!.error();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(2);
    connection.dispose();
  });

  it('validates preview frames and counts them as delivered for push recovery', async () => {
    vi.useFakeTimers();
    const { connection } = createConnection();
    const listener = vi.fn();
    await connection.register([{ '#h': [ROOM_A] }], listener);
    sockets[0]!.open();
    sockets[0]!.emit({ type: 'subscribed', roomId: ROOM_A });
    const frame = {
      type: 'sidebar-preview',
      roomId: ROOM_A,
      preview: {
        id: 'preview-message',
        text: 'short',
        createdAt: 1,
        presentation: 'message',
        author: { pubkey: 'a'.repeat(64), kind: 'agent', name: 'Agent' },
      },
    };
    sockets[0]!.emit(frame);
    expect(listener).toHaveBeenCalledWith({ monolithLive: frame });
    connection.notePushedMessage(ROOM_A, frame.preview.id);
    await vi.advanceTimersByTimeAsync(5001);
    expect(sockets).toHaveLength(1);
    listener.mockClear();
    sockets[0]!.emit({ ...frame, preview: { ...frame.preview, text: 'X'.repeat(241) } });
    expect(listener).toHaveBeenCalledExactlyOnceWith({ monolithLive: { type: 'invalidate', roomId: ROOM_A, reason: 'resync' } });
    expect(sockets[0]!.closed).toBe(false);
    connection.dispose();
  });

  it('dispatches identity-scoped workspace changes only to workspace registrations', async () => {
    const { connection } = createConnection();
    const workspace = vi.fn();
    const room = vi.fn();
    const stop = await connection.register([], workspace);
    await connection.register([{ '#h': [ROOM_A] }], room);
    sockets[0]!.open();
    workspace.mockClear();
    room.mockClear();
    const invalidation = { type: 'invalidate', roomId: '', reason: 'postgres:memberships' };
    sockets[0]!.emit(invalidation);
    expect(workspace).toHaveBeenCalledWith({ monolithLive: invalidation });
    expect(room).not.toHaveBeenCalled();
    const bookmark = {
      type: 'bookmark-delta',
      roomId: '',
      workspaceId: 'workspace',
      messageId: 'saved',
      bookmark: null,
    };
    const needs = {
      type: 'needs-you-delta',
      roomId: '',
      workspaceId: 'workspace',
      sourceRoomId: ROOM_A,
      count: 0,
      items: [],
    };
    const resource = { type: 'resource-change', roomId: '', resource: 'workbench' };
    sockets[0]!.emit(bookmark);
    sockets[0]!.emit(needs);
    sockets[0]!.emit(resource);
    expect(workspace).toHaveBeenCalledWith({ monolithLive: bookmark });
    expect(workspace).toHaveBeenCalledWith({ monolithLive: needs });
    expect(workspace).toHaveBeenCalledWith({ monolithLive: resource });
    expect(room).not.toHaveBeenCalled();
    stop();
    workspace.mockClear();
    sockets[0]!.emit(invalidation);
    expect(workspace).not.toHaveBeenCalled();
    connection.dispose();
  });

  it('starts the first room read while live authorization is still pending', async () => {
    let authorize!: (token: string) => void;
    const authorization = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          authorize = resolve;
        }),
    );
    const { connection } = createConnection(authorization);
    const fetch = vi.fn(async () => 'rooms');

    const registration = connection.register([{ '#h': [ROOM_A] }], () => undefined);
    const firstRead = registration.then(fetch);
    await Promise.resolve();
    await Promise.resolve();

    expect(fetch).toHaveBeenCalledOnce();
    expect(await firstRead).toBe('rooms');
    expect(sockets).toHaveLength(0);

    authorize('phone-session');
    await Promise.resolve();
    expect(sockets).toHaveLength(1);
    sockets[0]!.open();
    expect(sockets[0]!.sent).toEqual([
      JSON.stringify({
        type: 'subscribe',
        sidebarPreviews: true,
        roomStateProjections: true,
        roomIds: [ROOM_A],
      }),
    ]);
    (await registration)();
    connection.dispose();
  });

  it('opens one socket for two registrations and subscribes only new rooms', async () => {
    const { connection } = createConnection();
    const first: unknown[] = [];
    const second: unknown[] = [];

    await connection.register([{ '#h': [ROOM_A] }], (event) => first.push(event));
    expect(sockets).toHaveLength(1);
    sockets[0]!.open();
    expect(sockets[0]!.sent).toEqual([
      JSON.stringify({
        type: 'subscribe',
        sidebarPreviews: true,
        roomStateProjections: true,
        roomIds: [ROOM_A],
      }),
    ]);
    sockets[0]!.emit({ type: 'subscribed', roomId: ROOM_A });

    await connection.register([{ '#h': [ROOM_A, ROOM_B] }], (event) => second.push(event));
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.sent).toEqual([
      JSON.stringify({
        type: 'subscribe',
        sidebarPreviews: true,
        roomStateProjections: true,
        roomIds: [ROOM_A],
      }),
      JSON.stringify({
        type: 'subscribe',
        sidebarPreviews: true,
        roomStateProjections: true,
        roomIds: [ROOM_B],
      }),
    ]);
    expect(second).toEqual([{ monolithLive: { type: 'subscribed', roomId: ROOM_A } }]);
    expect(first).toEqual([{ monolithLive: { type: 'subscribed', roomId: ROOM_A } }]);

    connection.dispose();
  });

  it('marks a late join as continuous when the held Room has a cursor', async () => {
    const { connection } = createConnection();
    await connection.register([{ '#h': [ROOM_A] }], () => undefined);
    sockets[0]!.open();
    sockets[0]!.emit({
      type: 'subscribed',
      roomId: ROOM_A,
      epoch: 'epoch-1',
      cursor: 0,
      resumed: false,
    });
    const late = vi.fn();
    await connection.register([{ '#h': [ROOM_A] }], late);
    expect(late).toHaveBeenCalledWith({
      monolithLive: {
        type: 'subscribed',
        roomId: ROOM_A,
        epoch: 'epoch-1',
        cursor: 0,
        resumed: true,
      },
    });
    connection.dispose();
  });

  it('gives a late join the corner store, not a replayed corner status', async () => {
    const { connection } = createConnection();
    await connection.register([{ '#h': [ROOM_A] }], () => undefined);
    sockets[0]!.open();
    sockets[0]!.emit({
      type: 'subscribed',
      roomId: ROOM_A,
      epoch: 'epoch-1',
      cursor: 0,
      resumed: false,
    });
    const status = (state: string) => ({
      type: 'corner-status',
      roomId: ROOM_A,
      cornerCount: 1,
      waitingCornerCount: 0,
      openCorners: [],
      agentState: 'working',
      corners: [{ corner: { id: 'corner-1' }, state }],
    });
    sockets[0]!.emit(status('waiting'));
    sockets[0]!.emit(status('working'));
    const late: unknown[] = [];
    await connection.register([{ '#h': [ROOM_A] }], (event) => late.push(event));
    expect(late).toEqual([
      {
        monolithLive: {
          type: 'subscribed',
          roomId: ROOM_A,
          epoch: 'epoch-1',
          cursor: 0,
          resumed: true,
        },
      },
    ]);
    expect(getRoomCorners(ROOM_A).rows).toEqual([{ corner: { id: 'corner-1' }, state: 'working' }]);
    expect(getRoomCornerSummary(ROOM_A)).toEqual({ cornerCount: 1, openCorners: [] });
    connection.dispose();
  });

  it('Reproduction 5b25dbcb: restarts corner ordering and resume cursor on an in-place epoch change', async () => {
    const { connection } = createConnection();
    await connection.register([{ '#h': [ROOM_A] }], () => undefined);
    sockets[0]!.open();
    sockets[0]!.emit({ type: 'subscribed', roomId: ROOM_A, epoch: 'old', cursor: 20 });
    const status = (epoch: string, sequence: number, state: string) => ({
      type: 'corner-status',
      roomId: ROOM_A,
      epoch,
      sequence,
      cornerCount: 1,
      openCorners: [],
      corners: [{ corner: { id: 'corner-1' }, state }],
    });
    sockets[0]!.emit(status('old', 21, 'working'));
    sockets[0]!.emit(status('new', 1, 'idle'));
    expect(getRoomCorners(ROOM_A).rows?.[0]?.state).toBe('idle');
    sockets[0]!.emit(status('new', 1, 'working'));
    expect(getRoomCorners(ROOM_A).rows?.[0]?.state).toBe('idle');
    sockets.at(-1)!.drop();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    sockets[1]!.open();
    expect(sockets[1]!.sent.map((text) => JSON.parse(text))).toContainEqual({
      type: 'subscribe',
      sidebarPreviews: true,
      roomStateProjections: true,
      roomIds: [ROOM_A],
      cursors: { [ROOM_A]: { epoch: 'new', base: 1, seen: [] } },
    });
    connection.dispose();
  });

  it('writes every corner status into the corner store and delivers no older sequence', async () => {
    const { connection, changeIdentity } = createConnection();
    const heard: unknown[] = [];
    await connection.register([{ '#h': [ROOM_A] }], (event) => heard.push(event));
    sockets[0]!.open();
    sockets[0]!.emit({
      type: 'subscribed',
      roomId: ROOM_A,
      epoch: 'epoch-1',
      cursor: 1,
      resumed: false,
    });
    const status = (sequence: number, state: string) => ({
      type: 'corner-status',
      roomId: ROOM_A,
      sequence,
      cornerCount: 1,
      waitingCornerCount: 0,
      openCorners: [],
      agentState: null,
      corners: [{ corner: { id: 'corner-1' }, state }],
    });
    sockets[0]!.emit(status(2, 'review'));
    sockets[0]!.emit(status(1, 'working'));
    expect(heard.filter((event: any) => event.monolithLive.type === 'corner-status')).toEqual([
      { monolithLive: status(2, 'review') },
    ]);
    expect(getRoomCorners(ROOM_A)).toMatchObject({
      current: true,
      rows: [{ corner: { id: 'corner-1' }, state: 'review' }],
    });
    // A fresh lane restarts the sequence.
    sockets[0]!.emit({
      type: 'subscribed',
      roomId: ROOM_A,
      epoch: 'epoch-2',
      cursor: 1,
      resumed: false,
    });
    expect(getRoomCorners(ROOM_A).current).toBe(false);
    sockets[0]!.emit(status(1, 'working'));
    expect(getRoomCorners(ROOM_A).rows?.[0]?.state).toBe('working');
    // A new identity never sees the last one's corners: the store is on the client reset.
    changeIdentity();
    resetClientState();
    expect(getRoomCorners(ROOM_A).rows).toBeUndefined();
    connection.dispose();
  });

  it("marks a Room's corners unproven when the server names a change without rows", async () => {
    const { connection } = createConnection();
    await connection.register([{ '#h': [ROOM_A] }], () => undefined);
    sockets[0]!.open();
    sockets[0]!.emit({
      type: 'subscribed',
      roomId: ROOM_A,
      epoch: 'epoch-1',
      cursor: 0,
      resumed: false,
    });
    sockets[0]!.emit({
      type: 'corner-status',
      roomId: ROOM_A,
      cornerCount: 0,
      waitingCornerCount: 0,
      openCorners: [],
      agentState: null,
      corners: [],
    });
    expect(getRoomCorners(ROOM_A)).toMatchObject({ current: true, wantsRead: false });
    sockets[0]!.emit({ type: 'invalidate', roomId: ROOM_A, reason: 'corner-status' });
    expect(getRoomCorners(ROOM_A)).toMatchObject({ current: false, wantsRead: true });
    connection.dispose();
  });

  it('batches a large Room watch under the server frame limit', async () => {
    const { connection } = createConnection();
    const roomIds = Array.from({ length: 65 }, (_, index) => `room-${index}`);
    await connection.register([{ '#h': roomIds }], () => undefined);
    sockets[0]!.open();
    const frames = sockets[0]!.sent.map(
      (frame) =>
        JSON.parse(frame) as {
          type: string;
          roomIds: string[];
        },
    );
    expect(frames.map((frame) => frame.roomIds.length)).toEqual([32, 32, 1]);
    expect(frames.flatMap((frame) => frame.roomIds)).toEqual(roomIds);
    connection.dispose();
  });

  it('hands a room whose subscribe is still in flight exactly one subscribed frame', async () => {
    const { connection } = createConnection();
    const deck: unknown[] = [];
    const room: unknown[] = [];

    await connection.register([{ '#h': [ROOM_A] }], (event) => deck.push(event));
    sockets[0]!.open();
    expect(sockets[0]!.sent).toEqual([
      JSON.stringify({
        type: 'subscribe',
        sidebarPreviews: true,
        roomStateProjections: true,
        roomIds: [ROOM_A],
      }),
    ]);

    await connection.register([{ '#h': [ROOM_A] }], (event) => room.push(event));
    expect(room).toEqual([]);
    expect(sockets[0]!.sent).toEqual([
      JSON.stringify({
        type: 'subscribe',
        sidebarPreviews: true,
        roomStateProjections: true,
        roomIds: [ROOM_A],
      }),
    ]);

    sockets[0]!.emit({ type: 'subscribed', roomId: ROOM_A });
    expect(room).toEqual([{ monolithLive: { type: 'subscribed', roomId: ROOM_A } }]);
    expect(deck).toEqual([{ monolithLive: { type: 'subscribed', roomId: ROOM_A } }]);

    connection.dispose();
  });

  it('retires a room whose last holder left before the server confirmed it', async () => {
    const { connection } = createConnection();
    const room: unknown[] = [];
    const stop = await connection.register([{ '#h': [ROOM_A] }], (event) => room.push(event));
    sockets[0]!.open();
    expect(sockets[0]!.sent).toEqual([
      JSON.stringify({
        type: 'subscribe',
        sidebarPreviews: true,
        roomStateProjections: true,
        roomIds: [ROOM_A],
      }),
    ]);

    stop();
    expect(sockets[0]!.sent).toEqual([
      JSON.stringify({
        type: 'subscribe',
        sidebarPreviews: true,
        roomStateProjections: true,
        roomIds: [ROOM_A],
      }),
    ]);

    sockets[0]!.emit({ type: 'subscribed', roomId: ROOM_A });
    expect(sockets[0]!.sent).toEqual([
      JSON.stringify({
        type: 'subscribe',
        sidebarPreviews: true,
        roomStateProjections: true,
        roomIds: [ROOM_A],
      }),
      JSON.stringify({ type: 'unsubscribe', roomId: ROOM_A }),
    ]);

    sockets[0]!.emit({
      type: 'draft',
      roomId: ROOM_A,
      agentId: 'agent',
      turnId: 'turn-1',
      text: 'streaming',
    });
    const rejoined: unknown[] = [];
    await connection.register([{ '#h': [ROOM_A] }], (event) => rejoined.push(event));
    expect(rejoined).toEqual([]);

    connection.dispose();
  });

  it('synthesises subscribed and replays cached overlays to a late room join', async () => {
    const { connection } = createConnection();
    const deck: unknown[] = [];
    const room: unknown[] = [];

    await connection.register([{ '#h': [ROOM_A] }], (event) => deck.push(event));
    sockets[0]!.open();
    sockets[0]!.emit({ type: 'subscribed', roomId: ROOM_A });
    sockets[0]!.emit({
      type: 'draft',
      roomId: ROOM_A,
      agentId: 'agent',
      turnId: 'turn-1',
      text: 'streaming',
    });
    sockets[0]!.emit({
      type: 'thought',
      roomId: ROOM_A,
      agentId: 'agent',
      turnId: 'turn-1',
      text: 'thinking',
    });
    sockets[0]!.emit({
      type: 'presence',
      roomId: ROOM_A,
      agentId: 'agent',
      status: 'online',
      observedAt: 42,
    });

    await connection.register([{ '#h': [ROOM_A] }], (event) => room.push(event));

    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.sent).toEqual([
      JSON.stringify({
        type: 'subscribe',
        sidebarPreviews: true,
        roomStateProjections: true,
        roomIds: [ROOM_A],
      }),
    ]);
    expect(room).toEqual([
      { monolithLive: { type: 'subscribed', roomId: ROOM_A } },
      {
        monolithLive: {
          type: 'draft',
          roomId: ROOM_A,
          agentId: 'agent',
          turnId: 'turn-1',
          text: 'streaming',
        },
      },
      {
        monolithLive: {
          type: 'thought',
          roomId: ROOM_A,
          agentId: 'agent',
          turnId: 'turn-1',
          text: 'thinking',
        },
      },
      {
        monolithLive: {
          type: 'presence',
          roomId: ROOM_A,
          agentId: 'agent',
          status: 'online',
          observedAt: 42,
        },
      },
    ]);

    connection.dispose();
  });

  it('rebuilds an append-only draft and replays the accumulated text to a late join', async () => {
    const { connection } = createConnection();
    const first: unknown[] = [];
    const late: unknown[] = [];
    await connection.register([{ '#h': [ROOM_A] }], (event) => first.push(event));
    sockets[0]!.open();
    sockets[0]!.emit({ type: 'subscribed', roomId: ROOM_A });
    sockets[0]!.emit({
      type: 'draft',
      roomId: ROOM_A,
      agentId: 'agent',
      turnId: 'turn',
      text: 'Hello',
      revision: 0,
    });
    sockets[0]!.emit({
      type: 'draft-append',
      roomId: ROOM_A,
      agentId: 'agent',
      turnId: 'turn',
      offset: 5,
      revision: 1,
      chunk: ' world',
    });
    expect(first.at(-1)).toEqual({
      monolithLive: {
        type: 'draft',
        roomId: ROOM_A,
        agentId: 'agent',
        turnId: 'turn',
        text: 'Hello world',
        revision: 1,
        latestChunk: ' world',
      },
    });
    await connection.register([{ '#h': [ROOM_A] }], (event) => late.push(event));
    expect(late.at(-1)).toEqual(first.at(-1));
    connection.dispose();
  });

  it('resubscribes with a contiguous Room cursor and preserves overlays on resume', async () => {
    const { connection } = createConnection();
    const received: unknown[] = [];
    await connection.register([{ '#h': [ROOM_A] }], (event) => received.push(event));
    sockets[0]!.open();
    sockets[0]!.emit({
      type: 'subscribed',
      roomId: ROOM_A,
      epoch: 'server-1',
      cursor: 0,
      resumed: false,
    });
    sockets[0]!.emit({
      type: 'draft',
      roomId: ROOM_A,
      agentId: 'agent',
      turnId: 'turn',
      text: 'Hello',
      revision: 0,
      sequence: 1,
    });
    sockets.at(-1)!.drop();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    sockets[1]!.open();
    expect(JSON.parse(sockets[1]!.sent[0]!)).toEqual({
      type: 'subscribe',
      sidebarPreviews: true,
      roomStateProjections: true,
      roomIds: [ROOM_A],
      cursors: { [ROOM_A]: { epoch: 'server-1', base: 1, seen: [] } },
    });
    sockets[1]!.emit({
      type: 'subscribed',
      roomId: ROOM_A,
      epoch: 'server-1',
      cursor: 1,
      resumed: true,
    });
    const late: unknown[] = [];
    await connection.register([{ '#h': [ROOM_A] }], (event) => late.push(event));
    expect(late.at(-1)).toEqual({
      monolithLive: {
        type: 'draft',
        roomId: ROOM_A,
        agentId: 'agent',
        turnId: 'turn',
        text: 'Hello',
        revision: 0,
        sequence: 1,
      },
    });
    connection.dispose();
  });

  it('R-DURABLE-REPLAY: dedupes events and checkpoints filtered Room events', async () => {
    const { connection } = createConnection();
    const received = vi.fn();
    await connection.register([{ '#h': [ROOM_A] }], received);
    sockets[0]!.open();
    sockets[0]!.emit({ type: 'subscribed', roomId: ROOM_A, epoch: 'durable', cursor: 0 });
    received.mockClear();
    const event = {
      type: 'invalidate',
      roomId: ROOM_A,
      reason: 'message',
      epoch: 'durable',
      sequence: 1,
    };
    sockets[0]!.emit(event);
    sockets[0]!.emit(event);
    expect(received).toHaveBeenCalledTimes(1);
    sockets[0]!.emit({ type: 'cursor', roomId: ROOM_A, epoch: 'durable', sequence: 300 });
    sockets.at(-1)!.drop();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    sockets[1]!.open();
    expect(JSON.parse(sockets[1]!.sent[0]!).cursors[ROOM_A]).toEqual({
      epoch: 'durable',
      base: 300,
      seen: [],
    });
    connection.dispose();
  });

  it('R-DURABLE-REPLAY: resumes workspace cursors, dedupes replay, and applies reload', async () => {
    const { connection, changeIdentity } = createConnection();
    const received = vi.fn();
    await connection.register([], received);
    sockets[0]!.open();
    sockets[0]!.emit({
      type: 'workspace-cursor',
      roomId: '',
      workspaceId: 'workspace',
      epoch: 'durable',
      sequence: 10,
      reload: true,
    });
    expect(received).toHaveBeenCalledWith({
      monolithLive: { type: 'invalidate', roomId: '', reason: 'reconnect' },
    });
    received.mockClear();
    const event = {
      type: 'invalidate',
      roomId: '',
      reason: 'workspace-replay',
      workspaceId: 'workspace',
      epoch: 'durable',
      sequence: 11,
    };
    sockets[0]!.emit(event);
    sockets[0]!.emit(event);
    expect(received).toHaveBeenCalledTimes(1);
    sockets.at(-1)!.drop();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    sockets[1]!.open();
    expect(JSON.parse(sockets[1]!.sent[0]!)).toEqual({
      type: 'sync',
      workspaceCursors: {
        workspace: { epoch: 'durable', base: 11, seen: [] },
      },
    });
    changeIdentity();
    await vi.waitFor(() => expect(sockets).toHaveLength(3));
    sockets[2]!.open();
    expect(JSON.parse(sockets[2]!.sent[0]!)).toEqual({ type: 'sync', workspaceCursors: {} });
    connection.dispose();
  });

  it('R-DURABLE-REPLAY: reload invalidates the Room and starts at the server head', async () => {
    const { connection } = createConnection();
    const received = vi.fn();
    await connection.register([{ '#h': [ROOM_A] }], received);
    sockets[0]!.open();
    sockets[0]!.emit({ type: 'subscribed', roomId: ROOM_A, epoch: 'old', cursor: 0 });
    sockets[0]!.emit({ type: 'reload', roomId: ROOM_A, epoch: 'new', sequence: 1200 });
    expect(received).toHaveBeenCalledWith({
      monolithLive: { type: 'invalidate', roomId: ROOM_A, reason: 'resync' },
    });
    sockets.at(-1)!.drop();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    sockets[1]!.open();
    expect(JSON.parse(sockets[1]!.sent[0]!).cursors[ROOM_A]).toEqual({
      epoch: 'new',
      base: 1200,
      seen: [],
    });
    connection.dispose();
  });

  it('does not replay a draft whose turn already ended', async () => {
    const { connection } = createConnection();
    const room: unknown[] = [];

    await connection.register([{ '#h': [ROOM_A] }], () => undefined);
    sockets[0]!.open();
    sockets[0]!.emit({ type: 'subscribed', roomId: ROOM_A });
    sockets[0]!.emit({
      type: 'draft',
      roomId: ROOM_A,
      agentId: 'agent',
      turnId: 'turn-1',
      text: 'streaming',
    });
    sockets[0]!.emit({
      type: 'turn-delta',
      roomId: ROOM_A,
      turn: { requestId: 'turn-1', agentPubkey: 'agent', status: 'failed', createdAt: 1 },
    });

    await connection.register([{ '#h': [ROOM_A] }], (event) => room.push(event));

    expect(room).toEqual([{ monolithLive: { type: 'subscribed', roomId: ROOM_A } }]);
    connection.dispose();
  });

  it('selects workflow draft text from the socket overlay owner', async () => {
    const { connection } = createConnection();
    await connection.register([{ '#h': [ROOM_A] }], () => undefined);
    sockets[0]!.open();
    sockets[0]!.emit({ type: 'subscribed', roomId: ROOM_A });
    sockets[0]!.emit({
      type: 'draft',
      roomId: ROOM_A,
      agentId: 'agent',
      turnId: 'turn-1',
      text: 'whole text',
      latestChunk: 'first',
    });
    expect([...connection.liveDrafts(ROOM_A).values()]).toEqual(['first']);
    sockets[0]!.emit({
      type: 'draft',
      roomId: ROOM_A,
      agentId: 'agent',
      turnId: 'turn-1',
      text: 'whole text plus',
      latestChunk: 'second',
    });
    expect([...connection.liveDrafts(ROOM_A).values()]).toEqual(['second']);
    sockets[0]!.emit({
      type: 'turn-delta',
      roomId: ROOM_A,
      turn: { requestId: 'turn-1', agentPubkey: 'agent', status: 'complete', createdAt: 1 },
    });
    expect(connection.liveDrafts(ROOM_A).size).toBe(0);
    connection.dispose();
  });

  it('does not replay a draft older than the live window', async () => {
    vi.useFakeTimers();
    const { connection } = createConnection();
    const room: unknown[] = [];

    await connection.register([{ '#h': [ROOM_A] }], () => undefined);
    sockets[0]!.open();
    sockets[0]!.emit({ type: 'subscribed', roomId: ROOM_A });
    sockets[0]!.emit({
      type: 'draft',
      roomId: ROOM_A,
      agentId: 'agent',
      turnId: 'turn-1',
      text: 'streaming',
    });
    sockets[0]!.emit({
      type: 'presence',
      roomId: ROOM_A,
      agentId: 'agent',
      status: 'online',
      observedAt: 42,
    });

    await vi.advanceTimersByTimeAsync(90_000);
    await connection.register([{ '#h': [ROOM_A] }], (event) => room.push(event));

    expect(room).toEqual([
      { monolithLive: { type: 'subscribed', roomId: ROOM_A } },
      {
        monolithLive: {
          type: 'presence',
          roomId: ROOM_A,
          agentId: 'agent',
          status: 'online',
          observedAt: 42,
        },
      },
    ]);
    connection.dispose();
  });

  it('does not re-subscribe a room whose first subscribe is still unacknowledged', async () => {
    const { connection } = createConnection();
    const room: unknown[] = [];

    const stop = await connection.register([{ '#h': [ROOM_A] }], () => undefined);
    sockets[0]!.open();
    expect(sockets[0]!.sent).toEqual([
      JSON.stringify({
        type: 'subscribe',
        sidebarPreviews: true,
        roomStateProjections: true,
        roomIds: [ROOM_A],
      }),
    ]);

    stop();
    await connection.register([{ '#h': [ROOM_A] }], (event) => room.push(event));
    expect(sockets[0]!.sent).toEqual([
      JSON.stringify({
        type: 'subscribe',
        sidebarPreviews: true,
        roomStateProjections: true,
        roomIds: [ROOM_A],
      }),
    ]);

    sockets[0]!.emit({ type: 'subscribed', roomId: ROOM_A });
    expect(room).toEqual([{ monolithLive: { type: 'subscribed', roomId: ROOM_A } }]);
    expect(sockets[0]!.sent).toEqual([
      JSON.stringify({
        type: 'subscribe',
        sidebarPreviews: true,
        roomStateProjections: true,
        roomIds: [ROOM_A],
      }),
    ]);

    connection.dispose();
  });

  it('does not replay a retracted draft to a late listener', async () => {
    const { connection } = createConnection();
    const room: unknown[] = [];

    await connection.register([{ '#h': [ROOM_A] }], () => undefined);
    sockets[0]!.open();
    sockets[0]!.emit({ type: 'subscribed', roomId: ROOM_A });
    sockets[0]!.emit({
      type: 'draft',
      roomId: ROOM_A,
      agentId: 'agent',
      turnId: 'turn-1',
      text: 'streaming',
    });
    sockets[0]!.emit({
      type: 'retract',
      roomId: ROOM_A,
      agentId: 'agent',
      turnId: 'turn-1',
      kind: 'draft',
    });

    await connection.register([{ '#h': [ROOM_A] }], (event) => room.push(event));

    expect(room).toEqual([{ monolithLive: { type: 'subscribed', roomId: ROOM_A } }]);
    connection.dispose();
  });

  it('covers a no-room registration once per reopened socket and never on a timer', async () => {
    vi.useFakeTimers();
    const { connection } = createConnection();
    const received: unknown[] = [];

    await connection.register([], (event) => received.push(event));
    expect(sockets).toHaveLength(1);
    sockets[0]!.open();
    expect(sockets[0]!.sent).toEqual([JSON.stringify({ type: 'sync', workspaceCursors: {} })]);
    // Its own first read covers the first socket.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(received).toEqual([]);

    sockets[0]!.drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(2);
    expect(received).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(received).toEqual([
      { monolithLive: { type: 'invalidate', roomId: '', reason: 'reconnect' } },
    ]);

    connection.dispose();
  });
  it('only sends idle liveness pings without refreshing data', async () => {
    vi.useFakeTimers();
    const { connection } = createConnection();
    const first: unknown[] = [];
    const second: unknown[] = [];

    await connection.register([{ '#h': [ROOM_A] }], (event) => first.push(event));
    await connection.register([{ '#h': [ROOM_B] }], (event) => second.push(event));
    sockets[0]!.open();
    const request = connection.request('readWorkspaces', {});
    const frame = sockets[0]!.sent
      .map((value) => JSON.parse(value))
      .find((value) => value.t === 'req');
    sockets[0]!.emit({ t: 'res', id: frame.id, ok: true, result: { workspaces: [] } });
    await expect(request).resolves.toEqual({ workspaces: [] });
    const sent = [...sockets[0]!.sent];

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(sockets[0]!.sent.filter(frame => JSON.parse(frame).type !== 'ping')).toEqual(sent);
    expect(sockets).toHaveLength(1);

    connection.dispose();
  });
  it('keeps a healthy socket on a network notification without probing it', async () => {
    const { connection, networkChanged } = createConnection();
    await connection.register([{ '#h': [ROOM_A] }], () => {});
    sockets[0]!.open();
    const sent = [...sockets[0]!.sent];
    networkChanged();
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.sent).toEqual(sent);
    expect(sockets[0]!.closed).toBe(false);
    connection.dispose();
  });

  it('unsubscribes when the last holder leaves and keeps the socket open', async () => {
    const { connection } = createConnection();
    const stopFirst = await connection.register([{ '#h': [ROOM_A] }], () => undefined);
    const stopSecond = await connection.register([{ '#h': [ROOM_A] }], () => undefined);
    sockets[0]!.open();
    sockets[0]!.emit({ type: 'subscribed', roomId: ROOM_A });

    stopFirst();
    expect(sockets[0]!.sent).toEqual([
      JSON.stringify({
        type: 'subscribe',
        sidebarPreviews: true,
        roomStateProjections: true,
        roomIds: [ROOM_A],
      }),
    ]);
    expect(sockets[0]!.closed).toBe(false);

    stopSecond();
    expect(sockets[0]!.sent).toEqual([
      JSON.stringify({
        type: 'subscribe',
        sidebarPreviews: true,
        roomStateProjections: true,
        roomIds: [ROOM_A],
      }),
      JSON.stringify({ type: 'unsubscribe', roomId: ROOM_A }),
    ]);
    expect(sockets[0]!.closed).toBe(false);

    const reentered: unknown[] = [];
    await connection.register([{ '#h': [ROOM_A] }], (event) => reentered.push(event));
    expect(reentered).toEqual([]);
    expect(sockets[0]!.sent.at(-1)).toBe(
      JSON.stringify({
        type: 'subscribe',
        sidebarPreviews: true,
        roomStateProjections: true,
        roomIds: [ROOM_A],
      }),
    );

    connection.dispose();
  });

  it('fans an event only to live registrations that hold that room', async () => {
    const { connection } = createConnection();
    const first: unknown[] = [];
    const second: unknown[] = [];
    const stopFirst = await connection.register([{ '#h': [ROOM_A] }], (event) => first.push(event));
    await connection.register([{ '#h': [ROOM_B] }], (event) => second.push(event));
    sockets[0]!.open();

    sockets[0]!.emit({ type: 'invalidate', roomId: ROOM_A, reason: 'message' });
    expect(first).toEqual([
      { monolithLive: { type: 'invalidate', roomId: ROOM_A, reason: 'message' } },
    ]);
    expect(second).toEqual([]);

    stopFirst();
    sockets[0]!.emit({ type: 'invalidate', roomId: ROOM_A, reason: 'message' });
    expect(first).toHaveLength(1);

    connection.dispose();
  });

  it('resubscribes every current room after the socket drops', async () => {
    vi.useFakeTimers();
    const { connection } = createConnection();
    await connection.register([{ '#h': [ROOM_A] }], () => undefined);
    await connection.register([{ '#h': [ROOM_B] }], () => undefined);
    sockets[0]!.open();
    sockets[0]!.drop();

    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(sockets[1]!.sent).toEqual([
      JSON.stringify({
        type: 'subscribe',
        sidebarPreviews: true,
        roomStateProjections: true,
        roomIds: [ROOM_A, ROOM_B],
      }),
    ]);

    connection.dispose();
  });

  it('notifies subscribeConnected on first connect and every reconnect, never in between', async () => {
    vi.useFakeTimers();
    const { connection } = createConnection();
    const connectedCalls: number[] = [];
    let calls = 0;
    const unsubscribe = connection.subscribeConnected(() => {
      calls += 1;
      connectedCalls.push(calls);
    });
    await connection.register([{ '#h': [ROOM_A] }], () => undefined);
    expect(calls).toBe(0);
    sockets[0]!.open();
    expect(calls).toBe(1);

    sockets[0]!.emit({ type: 'subscribed', roomId: ROOM_A });
    sockets[0]!.emit({ type: 'invalidate', roomId: ROOM_A, reason: 'message' });
    expect(calls).toBe(1);

    sockets[0]!.drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(calls).toBe(2);

    unsubscribe();
    sockets.at(-1)!.drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(3);
    sockets[2]!.open();
    expect(calls).toBe(2);

    connection.dispose();
  });

  it('notifies observed disconnects and stops after unsubscribe', async () => {
    vi.useFakeTimers();
    const { connection } = createConnection();
    const disconnected = vi.fn();
    const unsubscribe = connection.subscribeDisconnected(disconnected);
    await connection.register([], () => undefined);
    sockets[0]!.open();
    expect(disconnected).not.toHaveBeenCalled();
    sockets[0]!.drop();
    expect(disconnected).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    sockets.at(-1)!.drop();
    expect(disconnected).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(0);
    sockets[2]!.open();
    unsubscribe();
    sockets[2]!.drop();
    expect(disconnected).toHaveBeenCalledTimes(2);
    connection.dispose();
  });

  it('ignores a sync acknowledgement and does not count it as a live frame', async () => {
    const { connection } = createConnection();
    const received: unknown[] = [];
    await connection.register([{ '#h': [ROOM_A] }], (event) => received.push(event));
    sockets[0]!.open();
    sockets[0]!.emit({ type: 'subscribed', roomId: ROOM_A });

    const epoch = liveFrameEpoch();
    sockets[0]!.emit({ type: 'sync-ok' });
    expect(liveFrameEpoch()).toBe(epoch);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.closed).toBe(false);
    expect(received).toEqual([{ monolithLive: { type: 'subscribed', roomId: ROOM_A } }]);

    connection.dispose();
  });

  it('keeps an open socket and in-flight send through a healthy foreground return', async () => {
    vi.useFakeTimers();
    const { connection, foreground, authorization } = createConnection();
    const disconnected = vi.fn();
    connection.subscribeDisconnected(disconnected);
    await connection.register([{ '#h': [ROOM_A] }], () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.open();
    const pending = connection.request('sendRoomMessage', {
      roomId: ROOM_A,
      messageId: 'm',
      text: 'hello',
    });
    void pending.catch(() => {});
    const request = JSON.parse(sockets[0]!.sent.at(-1)!);
    foreground();
    expect(sockets).toHaveLength(1);
    expect(disconnected).not.toHaveBeenCalled();
    sockets[0]!.emit({ t: 'res', id: request.id, ok: true, result: { messageId: 'm' } });
    await expect(pending).resolves.toEqual({ messageId: 'm' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets[0]!.closed).toBe(false);
    expect(authorization).toHaveBeenCalledOnce();
    expect(sockets[0]!.sent.filter((frame) => JSON.parse(frame).type === 'ping')).toHaveLength(3);
    connection.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['foreground'] as const)(
    'replaces a silently dead OPEN socket once after a %s challenge fails',
    async (boundary) => {
      vi.useFakeTimers();
      const { connection, foreground, networkChanged } = createConnection();
      try {
        await connection.register([{ '#h': [ROOM_A] }], () => {});
        await vi.advanceTimersByTimeAsync(0);
        sockets[0]!.open();
        sockets[0]!.autoPong = false;
        if (boundary === 'foreground') foreground();
        else networkChanged();
        networkChanged();
        expect(sockets[0]!.sent.filter((frame) => JSON.parse(frame).type === 'ping')).toHaveLength(
          1,
        );
        await vi.advanceTimersByTimeAsync(4_999);
        expect(sockets[0]!.closed).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(sockets[0]!.closed).toBe(true);
        expect(sockets).toHaveLength(2);
        sockets[1]!.open();
        sockets[1]!.drop();
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(sockets).toHaveLength(3);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        connection.dispose();
      }
    },
  );

  it('sends immediately during a foreground challenge and retains the responsive socket', async () => {
    vi.useFakeTimers();
    const { connection, foreground } = createConnection();
    try {
      await connection.register([], () => {});
      sockets[0]!.open();
      sockets[0]!.autoPong = false;
      foreground();
      const pending = connection.request('sendRoomMessage', {
        roomId: ROOM_A,
        messageId: 'm',
        text: 'hello',
      });
      const frame = JSON.parse(sockets[0]!.sent.at(-1)!);
      expect(frame).toMatchObject({ t: 'req', op: 'sendRoomMessage' });
      sockets[0]!.emit({ t: 'res', id: frame.id, ok: true, result: { messageId: 'm' } });
      await expect(pending).resolves.toEqual({ messageId: 'm' });
      await vi.advanceTimersByTimeAsync(4_999);
      sockets[0]!.emit({ type: 'pong' });
      sockets[0]!.autoPong = true;
      const traffic = [...sockets[0]!.sent];
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(sockets).toHaveLength(1);
      expect(sockets[0]!.closed).toBe(false);
      expect(sockets[0]!.sent.filter(frame => JSON.parse(frame).type !== 'ping')).toEqual(traffic.filter(frame => JSON.parse(frame).type !== 'ping'));
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      connection.dispose();
    }
  });

  it('keeps the foreground heartbeat after the last screen releases its watch', async () => {
    vi.useFakeTimers();
    const { connection, foreground, networkChanged } = createConnection();
    const release = await connection.register([], () => {});
    sockets[0]!.open();
    release();
    const traffic = [...sockets[0]!.sent];
    foreground();
    networkChanged();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets[0]!.sent.filter(frame => JSON.parse(frame).type !== 'ping')).toEqual(traffic);
    expect(sockets[0]!.sent.filter(frame => JSON.parse(frame).type === 'ping')).toHaveLength(3);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.closed).toBe(false);
    connection.dispose();
  });

  it('clears a pending challenge on identity change without replacing the new socket', async () => {
    vi.useFakeTimers();
    const { connection, foreground, changeIdentity } = createConnection();
    try {
      await connection.register([], () => {});
      sockets[0]!.open();
      sockets[0]!.autoPong = false;
      foreground();
      changeIdentity();
      await vi.advanceTimersByTimeAsync(0);
      sockets[1]!.open();
      sockets[0]!.emit({ type: 'pong' });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sockets).toHaveLength(2);
      expect(sockets[1]!.closed).toBe(false);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      connection.dispose();
    }
  });

  it('preserves a slow opening handshake when it opens before the request deadline', async () => {
    vi.useFakeTimers();
    const { connection, foreground, networkChanged } = createConnection();
    try {
      await connection.register([], () => {});
      const pending = connection.request('readRoom', { roomId: ROOM_A }, { timeoutMs: 25_000 });
      await vi.advanceTimersByTimeAsync(16_000);
      foreground();
      networkChanged();
      await vi.advanceTimersByTimeAsync(4_000);
      expect(sockets).toHaveLength(1);
      expect(sockets[0]!.closed).toBe(false);
      sockets[0]!.open();
      const frame = sockets[0]!.sent
        .map((value) => JSON.parse(value))
        .find((value) => value.t === 'req');
      sockets[0]!.emit({ t: 'res', id: frame.id, ok: true, result: { room: { id: ROOM_A } } });
      await expect(pending).resolves.toEqual({ room: { id: ROOM_A } });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sockets).toHaveLength(1);
      expect(sockets[0]!.closed).toBe(false);
    } finally {
      connection.dispose();
    }
  });



  it('an unheard push re-reads its Room over the healthy retained socket', async () => {
    const { connection } = createConnection();
    const room = vi.fn(), other = vi.fn();
    await connection.register([{ '#h': [ROOM_A] }], room);
    await connection.register([{ '#h': [ROOM_B] }], other);
    sockets[0]!.open();
    sockets[0]!.emit({ type: 'subscribed', roomId: ROOM_A });
    room.mockClear();
    connection.notePushedMessage(ROOM_A, 'missing');
    expect(room).toHaveBeenCalledExactlyOnceWith({ monolithLive: { type: 'invalidate', roomId: ROOM_A, reason: 'resync' } });
    expect(other).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(1); expect(sockets[0]!.closed).toBe(false);
    connection.dispose();
  });

  it('keeps a socket that already delivered the pushed message', async () => {
    vi.useFakeTimers();
    const { connection } = createConnection();
    await connection.register([{ '#h': [ROOM_A] }], () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.open();
    sockets[0]!.emit({ type: 'subscribed', roomId: ROOM_A });
    const delta = (id: string) => ({
      type: 'message-delta',
      roomId: ROOM_A,
      message: { id, text: 'hi', createdAt: 1, author: { pubkey: 'a'.repeat(64), kind: 'agent' } },
    });

    sockets[0]!.emit(delta('1'.repeat(64)));
    connection.notePushedMessage(ROOM_A, '1'.repeat(64));
    // A push for a Room this socket does not carry judges nothing.
    connection.notePushedMessage(ROOM_B, '3'.repeat(64));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.closed).toBe(false);

    connection.dispose();
  });

  it('tells the server which Rooms are on screen, once each way, and again on a new socket', async () => {
    vi.useFakeTimers();
    const { connection } = createConnection();
    await connection.register([{ '#h': [ROOM_A] }], () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    // A Room comes on screen before the socket opens: the open carries it.
    const releaseA = connection.view(ROOM_A);
    sockets[0]!.open();
    const viewing = (roomId: string, on: boolean) =>
      JSON.stringify({ type: 'viewing', roomId, viewing: on });
    expect(sockets[0]!.sent).toContain(viewing(ROOM_A, true));

    // A second holder of the same Room says nothing new; the last one leaving does.
    const releaseAgain = connection.view(ROOM_A);
    const releaseB = connection.view(ROOM_B);
    releaseAgain();
    releaseB();
    releaseB();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sockets[0]!.sent.filter((frame) => frame.includes('"viewing"'))).toEqual([
      viewing(ROOM_A, true),
      viewing(ROOM_B, true),
      viewing(ROOM_B, false),
    ]);

    // The server ended the old socket's views when it closed. The replacement
    // sends them again. Time passing does not open a further socket.
    sockets[0]!.drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(sockets[1]!.sent.filter((frame) => frame.includes('"viewing"'))).toEqual([
      viewing(ROOM_A, true),
    ]);
    releaseA();
    expect(sockets[1]!.sent).toContain(viewing(ROOM_A, false));

    connection.dispose();
  });
  it('reopens once after a server disconnect and resubscribes with the catch-up cursor', async () => {
    vi.useFakeTimers();
    const { connection } = createConnection();
    const room = vi.fn();
    await connection.register([{ '#h': [ROOM_A] }], room);
    sockets[0]!.open();
    sockets[0]!.emit({ type: 'subscribed', roomId: ROOM_A, epoch: 'epoch-1', cursor: 4 });
    room.mockClear();

    sockets[0]!.drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(2);

    sockets[1]!.open();
    expect(JSON.parse(sockets[1]!.sent[0]!)).toEqual({
      type: 'subscribe',
      sidebarPreviews: true,
      roomStateProjections: true,
      roomIds: [ROOM_A],
      cursors: { [ROOM_A]: { epoch: 'epoch-1', base: 4, seen: [] } },
    });
    sockets[1]!.emit({
      type: 'subscribed',
      roomId: ROOM_A,
      epoch: 'epoch-1',
      cursor: 9,
      resumed: true,
    });
    expect(room).toHaveBeenCalledWith({
      monolithLive: {
        type: 'subscribed',
        roomId: ROOM_A,
        epoch: 'epoch-1',
        cursor: 9,
        resumed: true,
      },
    });

    sockets[1]!.drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(3);

    connection.dispose();
  });

  it('covers a no-room registration on a proven disconnect, never on foreground alone', async () => {
    vi.useFakeTimers();
    const { connection, foreground } = createConnection();
    const received = vi.fn();
    await connection.register([], received);
    sockets[0]!.open();
    foreground();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(received).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(1);
    sockets[0]!.drop();
    await vi.advanceTimersByTimeAsync(0);
    sockets[1]!.open();
    expect(received).toHaveBeenCalledExactlyOnceWith({
      monolithLive: { type: 'invalidate', roomId: '', reason: 'reconnect' },
    });
    connection.dispose();
  });

  it('renews a rejected cached access token once and stops if the replacement handshake fails', async () => {
    vi.useFakeTimers();
    const invalidateAuthorization = vi.fn();
    const authorization = vi
      .fn()
      .mockResolvedValueOnce('cached-access')
      .mockResolvedValue('renewed-access');
    const connection = new LiveConnection({
      authorization,
      invalidateAuthorization,
      liveUrl: () => 'wss://server.example/v1/phone/live',
      subscribeIdentityChange: () => () => {},
    });
    const received = vi.fn();
    await connection.register([], received);
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.error();
    await vi.advanceTimersByTimeAsync(0);
    expect(invalidateAuthorization).toHaveBeenCalledExactlyOnceWith('cached-access');
    expect(sockets[1]!.protocols).toEqual(['bearer.renewed-access']);
    sockets[1]!.error();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(2);
    connection.dispose();
  });

  it('covers Workspace discovery when the first successful socket follows a rejected handshake', async () => {
    vi.useFakeTimers();
    const received = vi.fn();
    const connection = new LiveConnection({
      authorization: vi.fn().mockResolvedValue('token'),
      invalidateAuthorization: vi.fn(),
      liveUrl: () => 'wss://server.example/v1/phone/live',
      subscribeIdentityChange: () => () => {},
    });
    await connection.register([], received);
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.error();
    await vi.advanceTimersByTimeAsync(0);
    sockets[1]!.open();
    expect(received).toHaveBeenCalledExactlyOnceWith({
      monolithLive: { type: 'invalidate', roomId: '', reason: 'reconnect' },
    });
    connection.dispose();
  });

  it('expires a stuck authorization flight so Reconnect can obtain credentials again', async () => {
    vi.useFakeTimers();
    const authorization = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue('recovered-access');
    const { connection } = createConnection(authorization);
    await connection.register([], () => {});
    await vi.advanceTimersByTimeAsync(15_000);
    expect(connection.diagnostics().connecting).toBe(false);
    connection.reconnectNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets[0]!.protocols).toEqual(['bearer.recovered-access']);
    connection.dispose();
  });

  it('fences late router capabilities after the authorization flight expires', async () => {
    vi.useFakeTimers();
    const capabilities = { families: [] as const, authorityFencesV1: true };
    let release!: (value: typeof capabilities) => void;
    const requestedCapabilities = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue(capabilities);
    const connection = new LiveConnection({
      authorization: async () => 'token',
      liveUrl: () => 'wss://server.example/v1/phone/live',
      subscribeIdentityChange: () => () => {},
      router: {
        requestedCapabilities,
        negotiated: vi.fn(async () => {}),
        disconnected: vi.fn(),
        receive: vi.fn(),
      },
    });
    await connection.register([], () => {});
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sockets).toHaveLength(1);
    expect(requestedCapabilities).toHaveBeenCalledTimes(2);
    expect(connection.diagnostics().connecting).toBe(false);
    release(capabilities);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sockets).toHaveLength(1);
    expect(requestedCapabilities).toHaveBeenCalledTimes(2);
    expect(sockets[0]!.closed).toBe(false);
    connection.reconnectNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.closed).toBe(false);
    connection.dispose();
  });

  it('NATIVE-142-AUTH: retries transient authorization failure immediately and opens the waiting Room', async () => {
    vi.useFakeTimers();
    const authorization = vi
      .fn()
      .mockRejectedValueOnce(new Error('session refresh failed'))
      .mockResolvedValue('phone-session');
    const { connection } = createConnection(authorization);
    await connection.register([{ '#h': [ROOM_A] }], () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(authorization).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(1);
    sockets[0]!.open();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
    connection.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resubscribes mounted registrations on a new socket after an identity change', async () => {
    const { connection, changeIdentity } = createConnection();
    const room: Array<{ monolithLive: { type: string; reason?: string; resumed?: boolean } }> = [];
    const roomless: Array<{ monolithLive: { type: string; reason?: string } }> = [];
    await connection.register([{ '#h': [ROOM_A] }], (event) =>
      room.push(event as (typeof room)[number]),
    );
    await connection.register([], (event) => roomless.push(event as (typeof roomless)[number]));
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.open();
    sockets[0]!.emit({ type: 'subscribed', roomId: ROOM_A, epoch: 'old', cursor: 7 });
    room.length = 0;

    changeIdentity();
    expect(sockets[0]!.closed).toBe(true);
    sockets[0]!.emit({ type: 'invalidate', roomId: ROOM_A, reason: 'old-account' });
    expect(room).toEqual([]);

    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    sockets[1]!.open();
    expect(sockets[1]!.sent.map((frame) => JSON.parse(frame))).toEqual([
      { type: 'subscribe', sidebarPreviews: true, roomStateProjections: true, roomIds: [ROOM_A] },
      { type: 'sync', workspaceCursors: {} },
    ]);
    expect(roomless.map((event) => event.monolithLive)).toEqual([
      { type: 'invalidate', roomId: '', reason: 'reconnect' },
    ]);
    sockets[1]!.emit({ type: 'subscribed', roomId: ROOM_A, epoch: 'new', cursor: 0 });
    sockets[1]!.emit({ type: 'invalidate', roomId: ROOM_A, reason: 'message' });
    expect(room.map((event) => event.monolithLive.type)).toEqual(['subscribed', 'invalidate']);

    connection.dispose();
  });

  it('keeps a held view across an identity change', async () => {
    const { connection, changeIdentity } = createConnection();
    await connection.register([{ '#h': [ROOM_A] }], () => undefined);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.open();
    const release = connection.view(ROOM_A);

    changeIdentity();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    sockets[1]!.open();
    release();
    expect(sockets[1]!.sent.map((frame) => JSON.parse(frame))).toEqual([
      { type: 'viewing', roomId: ROOM_A, viewing: true },
      { type: 'subscribe', sidebarPreviews: true, roomStateProjections: true, roomIds: [ROOM_A] },
      { type: 'viewing', roomId: ROOM_A, viewing: false },
    ]);

    connection.dispose();
  });

  it('closes the socket and stops delivery on dispose', async () => {
    vi.useFakeTimers();
    const { connection } = createConnection();
    const received: unknown[] = [];
    await connection.register([{ '#h': [ROOM_A] }], (event) => received.push(event));
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.open();

    connection.dispose();
    expect(sockets[0]!.closed).toBe(true);
    sockets[0]!.drop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sockets).toHaveLength(1);
    sockets[0]!.emit({ type: 'invalidate', roomId: ROOM_A, reason: 'message' });
    expect(received).toEqual([]);
  });

  it('routes trace-painted to the registration that sent trace-paint', async () => {
    const { connection } = createConnection();
    const first: Array<{
      acknowledgePaint?: () => void;
      monolithLive: { type: string; id?: string };
    }> = [];
    const second: Array<{ monolithLive: { type: string; id?: string } }> = [];
    await connection.register([{ '#h': [ROOM_A] }], (event) =>
      first.push(event as (typeof first)[number]),
    );
    await connection.register([{ '#h': [ROOM_A] }], (event) =>
      second.push(event as (typeof second)[number]),
    );
    sockets[0]!.open();
    sockets[0]!.emit({
      type: 'message-delta',
      roomId: ROOM_A,
      message: { id: 'message', text: 'done' },
      trace: { id: 'trace-direct', startedAt: 10, databaseAt: 11, emittedAt: 12 },
    });

    first[0]!.acknowledgePaint?.();
    expect(sockets[0]!.sent.at(-1)).toBe(
      JSON.stringify({ type: 'trace-paint', id: 'trace-direct' }),
    );

    sockets[0]!.emit({
      type: 'trace-painted',
      id: 'trace-direct',
      databaseAt: 11,
      upperBoundMs: 4,
    });
    expect(first.filter((event) => event.monolithLive.type === 'trace-painted')).toHaveLength(1);
    expect(second.some((event) => event.monolithLive.type === 'trace-painted')).toBe(false);

    sockets[0]!.emit({
      type: 'trace-painted',
      id: 'trace-direct',
      databaseAt: 11,
      upperBoundMs: 4,
    });
    expect(first.filter((event) => event.monolithLive.type === 'trace-painted')).toHaveLength(1);

    connection.dispose();
  });

  it('does not let a closed registration acknowledge paint on a later socket', async () => {
    const { connection } = createConnection();
    const received: Array<{ acknowledgePaint?: () => void }> = [];
    const stop = await connection.register([{ '#h': [ROOM_A] }], (event) =>
      received.push(event as (typeof received)[number]),
    );
    sockets[0]!.open();
    sockets[0]!.emit({
      type: 'turn-delta',
      roomId: ROOM_A,
      turn: { requestId: 'request', agentId: 'agent', status: 'working', createdAt: 1 },
      trace: {
        id: 'trace-database-clock',
        databaseAt: 10,
        emittedAt: 12,
        paintAck: 'database-clock',
      },
    });
    expect(received[0]!.acknowledgePaint).toEqual(expect.any(Function));
    received[0]!.acknowledgePaint?.();
    expect(sockets[0]!.sent.at(-1)).toBe(
      JSON.stringify({ type: 'trace-paint', id: 'trace-database-clock' }),
    );

    stop();
    const sentAfterStop = sockets[0]!.sent.length;
    received[0]!.acknowledgePaint?.();
    expect(sockets[0]!.sent).toHaveLength(sentAfterStop);

    connection.dispose();
  });
});

describe('phone socket request/reply', () => {
  beforeEach(() => {
    appStateListeners.clear();
    AppState.currentState = 'active';
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it('M1: observes declared inputs locally without changing the legacy frame or starting background work', async () => {
    const sockets = stubSockets(),
      { connection, changeIdentity } = createConnection();
    await connection.register([], () => {});
    sockets[0]!.open();
    const result = connection.request('countNeedsYou', { workspaceId: 'private-workspace' });
    const frame = sockets[0]!.sent.find((value) => JSON.parse(value).t === 'req')!;
    expect(frame).toBe(
      JSON.stringify({
        t: 'req',
        id: 'phone-1',
        op: 'countNeedsYou',
        args: { workspaceId: 'private-workspace' },
      }),
    );
    expect(connection.routeDiagnostics()).toEqual([
      { route: 'phone.countNeedsYou', verdict: 'legacy-valid' },
    ]);
    expect(JSON.stringify(connection.routeDiagnostics())).not.toContain('private-workspace');
    expect(connection.diagnostics()).not.toHaveProperty('routes');
    sockets[0]!.emit({ t: 'res', id: 'phone-1', ok: true, result: { count: 2 } });
    expect(await result).toEqual({ count: 2 });
    const before = sockets[0]!.sent.slice();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.sent.filter(frame => JSON.parse(frame).type !== 'ping')).toEqual(before);
    changeIdentity();
    expect(connection.routeDiagnostics()).toEqual([]);
    connection.dispose();
  });

  it('M1: a shadow codec mismatch cannot block or rewrite a legacy request', async () => {
    const sockets = stubSockets(),
      { connection } = createConnection();
    await connection.register([], () => {});
    sockets[0]!.open();
    const result = connection.request('countNeedsYou', { workspaceId: 7 } as never);
    const frame = sockets[0]!.sent
      .map((value) => JSON.parse(value))
      .find((value) => value.t === 'req');
    expect(frame.args).toEqual({ workspaceId: 7 });
    expect(connection.routeDiagnostics()).toEqual([
      { route: 'phone.countNeedsYou', verdict: 'legacy-invalid' },
    ]);
    sockets[0]!.emit({ t: 'res', id: frame.id, ok: true, result: { count: 0 } });
    expect(await result).toEqual({ count: 0 });
    connection.dispose();
    expect(connection.routeDiagnostics()).toEqual([]);
  });

  it('waits for open and matches reversed replies once, without live fanout', async () => {
    const sockets = stubSockets(),
      { connection } = createConnection(),
      listener = vi.fn();
    await connection.register([], listener);
    const first = connection.request('readWorkspaces', {}),
      second = connection.request('voiceCurrent', { roomId: 'r' });
    expect(sockets[0]!.sent).toEqual([]);
    sockets[0]!.open();
    const frames = sockets[0]!.sent.map((v) => JSON.parse(v)).filter((v) => v.t === 'req');
    expect(frames).toHaveLength(2);
    expect(frames[0].id).not.toBe(frames[1].id);
    sockets[0]!.emit({ t: 'res', id: 'unknown', ok: true, result: 0 });
    sockets[0]!.emit({ t: 'res', id: frames[1].id, ok: true, result: null });
    sockets[0]!.emit({ t: 'res', id: frames[1].id, ok: true, result: 'duplicate' });
    sockets[0]!.emit({ t: 'res', id: frames[0].id, ok: true, result: { workspaces: [] } });
    expect(await second).toBeNull();
    expect(await first).toEqual({ workspaces: [] });
    expect(listener).not.toHaveBeenCalled();
    connection.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cleans up cancellation and ignores its late answer without a deadline miss', async () => {
    const sockets = stubSockets(),
      { connection } = createConnection();
    await connection.register([], () => {});
    sockets[0]!.open();
    const missed = vi.spyOn(connection, 'reportRequestDeadlineMissed'),
      controller = new AbortController();
    const result = connection
      .request('readWorkspaces', {}, { signal: controller.signal })
      .catch((e) => e);
    controller.abort();
    expect((await result).name).toBe('AbortError');
    sockets[0]!.emit({
      t: 'res',
      id: JSON.parse(sockets[0]!.sent.at(-1)!).id,
      ok: true,
      result: {},
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(missed).not.toHaveBeenCalled();
    connection.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects in-flight sends on close and queued reads on identity change', async () => {
    const sockets = stubSockets(),
      { connection, changeIdentity } = createConnection();
    await connection.register([], () => {});
    sockets[0]!.open();
    const first = connection
      .request('sendRoomMessage', { roomId: 'r', messageId: 'm', text: 'hello' })
      .catch((e) => e);
    sockets[0]!.drop();
    expect((await first).name).toBe('PhoneSocketDisconnectedError');
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(sockets[1]!.sent.some((v) => JSON.parse(v).t === 'req')).toBe(false);
    const second = connection.request('readWorkspaces', {}).catch((e) => e);
    changeIdentity();
    expect((await second).name).toBe('PhoneSocketDisconnectedError');
    connection.dispose();
  });
  it('bounds pending calls, validates reply shape and frees a slot after refusal', async () => {
    const sockets = stubSockets(),
      { connection } = createConnection();
    await connection.register([], () => {});
    sockets[0]!.open();
    const pending = Array.from({ length: 32 }, () =>
      connection.request('readWorkspaces', {}).catch((e) => e),
    );
    await expect(connection.request('readWorkspaces', {})).rejects.toMatchObject({
      code: 'busy',
      retryable: true,
    });
    const id = sockets[0]!.sent.map((v) => JSON.parse(v)).find((v) => v.t === 'req').id;
    sockets[0]!.emit({ t: 'res', id, ok: true });
    await expect(connection.request('readWorkspaces', {})).rejects.toMatchObject({ code: 'busy' });
    sockets[0]!.emit({
      t: 'res',
      id,
      ok: false,
      error: { code: 'access_denied', message: 'Owner only', retryable: false },
    });
    expect(await pending[0]).toMatchObject({ status: 403, message: 'Owner only' });
    const next = connection.request('readWorkspaces', {}).catch((e) => e);
    connection.dispose();
    await Promise.all([...pending, next]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('sends Room and Room-list reads independently of screen paint', async () => {
    const sockets = stubSockets(), { connection } = createConnection();
    await connection.register([], () => {});
    sockets[0]!.open();
    const reads = [connection.request('readRoom', { roomId: 'r' }),
      connection.request('readChats', { workspaceId: 'w' })];
    const frames = sockets[0]!.sent.map(v => JSON.parse(v)).filter(v => v.t === 'req');
    expect(frames.map(v => v.op)).toEqual(['readRoom', 'readChats']);
    for (const frame of frames) sockets[0]!.emit({ t: 'res', id: frame.id, ok: true, result: {} });
    await Promise.all(reads);
    connection.dispose();
  });

  it('rejects oversized UTF-8 frames before opening a socket', async () => {
    const sockets = stubSockets(),
      { connection } = createConnection();
    await expect(
      connection.request('sendRoomMessage', {
        roomId: 'r',
        messageId: 'm',
        text: '🐝'.repeat(20_000),
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(sockets).toHaveLength(0);
    connection.dispose();
  });
});

describe('native brief-drop recovery', () => {
  beforeEach(() => {
    appStateListeners.clear();
    AppState.currentState = 'active';
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps an unsent text through a close callback and dispatches it once on reopen', async () => {
    const sockets = stubSockets(),
      { connection } = createConnection();
    const release = await connection.register([], () => {});
    sockets[0]!.open();
    release(); // The pending call alone must hold recovery, even without a screen.
    sockets[0]!.readyState = 3; // Native closure precedes its JS callback.
    const pending = connection.request('sendRoomMessage', {
      roomId: ROOM_A,
      messageId: 'm',
      text: 'hello',
    });
    void pending.catch(() => {});
    expect(sockets[0]!.sent.some((value) => JSON.parse(value).t === 'req')).toBe(false);
    sockets[0]!.drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    const frames = sockets[1]!.sent
      .map((value) => JSON.parse(value))
      .filter((frame) => frame.t === 'req');
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ op: 'sendRoomMessage', args: { messageId: 'm' } });
    sockets[1]!.emit({ t: 'res', id: frames[0].id, ok: true, result: { messageId: 'm' } });
    await expect(pending).resolves.toEqual({ messageId: 'm' });
    connection.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps an unsent call through one transient authorization failure', async () => {
    const sockets = stubSockets();
    let fail!: (error: Error) => void;
    const authorization = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            fail = reject;
          }),
      )
      .mockResolvedValue('recovered');
    const { connection } = createConnection(authorization);
    const pending = connection.request('sendRoomMessage', {
      roomId: ROOM_A,
      messageId: 'm',
      text: 'hello',
    });
    void pending.catch(() => {});
    fail(new Error('transient refresh failure'));
    await vi.advanceTimersByTimeAsync(0);
    expect(authorization).toHaveBeenCalledTimes(2);
    sockets[0]!.open();
    const frame = JSON.parse(sockets[0]!.sent[0]!);
    sockets[0]!.emit({ t: 'res', id: frame.id, ok: true, result: { messageId: 'm' } });
    await expect(pending).resolves.toEqual({ messageId: 'm' });
    connection.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('NATIVE-142-AUTH: one failed refresh after a rejected upgrade does not strand the outbox', async () => {
    const sockets = stubSockets();
    const authorization = vi
      .fn()
      .mockResolvedValueOnce('cached')
      .mockRejectedValueOnce(new Error('transient refresh failure'))
      .mockResolvedValue('renewed');
    const invalidateAuthorization = vi.fn(),
      connected = vi.fn();
    const connection = new LiveConnection({
      authorization,
      invalidateAuthorization,
      liveUrl: () => 'wss://server.example/v1/phone/live',
      subscribeIdentityChange: () => () => {},
    });
    connection.subscribeConnected(connected);
    await connection.register([], () => {});
    sockets[0]!.error();
    await vi.advanceTimersByTimeAsync(0);
    expect(authorization).toHaveBeenCalledTimes(3);
    expect(invalidateAuthorization).toHaveBeenCalledExactlyOnceWith('cached');
    sockets[1]!.open();
    expect(connected).toHaveBeenCalledOnce(); // The app-wide outbox flush trigger.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(2);
    connection.dispose();
  });

  it('stops after a second authorization error and rejects the waiting call', async () => {
    const sockets = stubSockets(),
      authorization = vi.fn().mockRejectedValue(new Error('offline'));
    const { connection } = createConnection(authorization);
    const pending = connection.request('readWorkspaces', {}).catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect((await pending).message).toBe('offline');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(authorization).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(0);
    connection.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });


  it('does not retry authorization while Android has the app in the background', async () => {
    stubSockets();
    AppState.currentState = 'background';
    const authorization = vi.fn().mockRejectedValue(new Error('offline'));
    const { connection } = createConnection(authorization);
    await connection.register([], () => {});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(authorization).toHaveBeenCalledOnce();
    connection.dispose();
  });

  it('ignores late credentials after the authorization cutoff and does not restart a disposed flight', async () => {
    const sockets = stubSockets();
    let late!: (token: string) => void;
    const authorization = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            late = resolve;
          }),
      )
      .mockResolvedValue('current');
    const { connection } = createConnection(authorization);
    await connection.register([], () => {});
    await vi.advanceTimersByTimeAsync(15_000);
    expect(authorization).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(1);
    late('stale');
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.protocols).toEqual(['bearer.current']);
    connection.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows a slow native handshake past 15 seconds without an authorization cutoff', async () => {
    const sockets = stubSockets(),
      { connection } = createConnection();
    await connection.register([], () => {});
    await vi.advanceTimersByTimeAsync(16_000);
    expect(sockets[0]!.closed).toBe(false);
    const pending = connection.request('sendRoomMessage', {
      roomId: ROOM_A,
      messageId: 'm',
      text: 'hello',
    });
    void pending.catch(() => {});
    sockets[0]!.open();
    const frame = sockets[0]!.sent
      .map((value) => JSON.parse(value))
      .find((frame) => frame.t === 'req');
    sockets[0]!.emit({ t: 'res', id: frame.id, ok: true, result: { messageId: 'm' } });
    await expect(pending).resolves.toEqual({ messageId: 'm' });
    connection.dispose();
  });
});
