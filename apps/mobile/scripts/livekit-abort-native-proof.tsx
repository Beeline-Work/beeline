/** Disposable Hermes proof; no account, microphone, or production server. */
import 'react-native-get-random-values';
import '@livekit/react-native';
import React, { useEffect, useState } from 'react';
import { AppRegistry, Text, View } from 'react-native';
import { Room, ConnectionError, ConnectionErrorReason } from 'livekit-client';

async function prove(): Promise<string> {
  const runtime = globalThis as typeof globalThis & { HermesInternal?: unknown };
  if (!runtime.HermesInternal) throw new Error('This proof requires Hermes');
  const eventGlobal = typeof globalThis.Event;
  if (eventGlobal !== 'undefined') throw new Error(`Expected Hermes without Event, got ${eventGlobal}`);
  const originalSocket = globalThis.WebSocket;
  let socketCreated!: () => void;
  const ready = new Promise<void>(resolve => { socketCreated = resolve; });
  globalThis.WebSocket = class {
    static CLOSED = 3;
    readyState = 0;
    constructor() { socketCreated(); }
    addEventListener() {}
    removeEventListener() {}
    close() { this.readyState = 3; }
  } as unknown as typeof WebSocket;
  try {
    const room = new Room();
    const controller = new AbortController();
    const client = (room as unknown as { engine: { client: {
      join(...args: unknown[]): Promise<unknown>;
    } } }).engine.client;
    let listenerResult: Promise<unknown> | undefined;
    const add = controller.signal.addEventListener.bind(controller.signal);
    controller.signal.addEventListener = ((type: string, listener: (event: Event) => unknown) => {
      add(type, event => {
        listenerResult = Promise.resolve(listener(event));
        void listenerResult.catch(() => {});
      });
    }) as typeof controller.signal.addEventListener;
    const result = client.join('ws://localhost:7880', 'disposable-fixture', {
      autoSubscribe: true, maxRetries: 0, e2eeEnabled: false,
      websocketTimeout: 2000, singlePeerConnection: false,
    }, controller.signal, true).catch(error => error);
    await ready;
    controller.abort();
    await listenerResult;
    const error = await result;
    if (!(error instanceof ConnectionError) || error.reason !== ConnectionErrorReason.Cancelled) throw error;
    return `PASS: Hermes, Event=${eventGlobal}, cancelled=${error.reason}, ${error.message}`;
  } finally {
    globalThis.WebSocket = originalSocket;
  }
}

function Proof() {
  const [result, setResult] = useState('Running ANDROID-EVENT-ABORT-1');
  useEffect(() => {
    void prove().then(setResult, error => setResult(`FAIL: ${error.name}: ${error.message}`));
  }, []);
  useEffect(() => { console.log('ANDROID-EVENT-ABORT-1', result); }, [result]);
  return <View style={{ flex: 1, padding: 48, backgroundColor: '#ffffff' }}>
    <Text style={{ color: '#111111', fontSize: 22 }}>{result}</Text>
  </View>;
}

AppRegistry.registerComponent('main', () => Proof);
