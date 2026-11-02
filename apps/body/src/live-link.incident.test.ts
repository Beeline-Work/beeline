import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { LiveLink } from './live-link.js';
class Socket extends EventEmitter {
  readyState=0;onopen?:()=>void;onclose?:()=>void;onmessage?:()=>void;
  send=vi.fn();ping=vi.fn();
  open(){this.readyState=1;this.onopen?.();}
  terminate(){this.readyState=3;this.onclose?.();}
  close(){this.terminate();}
}
afterEach(()=>{vi.useRealTimers();});
it('allows one automatic replacement, then parks a brief uncertified open for a day',async()=>{
  vi.useFakeTimers();const sockets:Socket[]=[];
  const factory=vi.fn(()=>{const socket=new Socket();sockets.push(socket);return socket as unknown as WebSocket;});
  const link=new LiveLink({url:()=> 'ws://synthetic.invalid',protocols:()=>[],factory,onOpen:()=>undefined,
    onClose:()=>undefined,onMessage:()=>undefined,onUpdateRequired:()=>undefined});
  link.start();sockets[0]!.open();link.markRecovered();sockets[0]!.terminate();
  expect(sockets).toHaveLength(2);
  sockets[1]!.open();sockets[1]!.terminate();
  await vi.advanceTimersByTimeAsync(86_400_000);link.start();expect(sockets).toHaveLength(2);
  link.reconnectNow();expect(sockets).toHaveLength(3);sockets[2]!.open();link.markRecovered();
  sockets[2]!.terminate();expect(sockets).toHaveLength(4);link.stop();
});
it('parks a failed initial connection rather than creating a timed replacement',async()=>{
  vi.useFakeTimers();const socket=new Socket(),factory=vi.fn(()=>socket as unknown as WebSocket);
  const link=new LiveLink({url:()=> 'ws://synthetic.invalid',protocols:()=>[],factory,onOpen:()=>undefined,
    onClose:()=>undefined,onMessage:()=>undefined,onUpdateRequired:()=>undefined});
  link.start();socket.terminate();await vi.advanceTimersByTimeAsync(86_400_000);
  expect(factory).toHaveBeenCalledTimes(1);expect(link.state).toBe('disconnected');link.stop();
});
