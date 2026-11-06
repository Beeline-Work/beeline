import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import type { DaemonApiClient } from './daemon-api-client.js';
import { AcpRuntimeExitedError } from './acp.js';
import { AgentProcesses } from './agent-process.js';
import { CommandExecutionContext, runServerCommandIntake } from './server-command-intake.js';
import { DaemonApiError } from './daemon-api-client.js';

function command(id: string, body = id, action: AgentCommand['action'] = 'input'): AgentCommand {
  return {
    id,
    roomId: 'room',
    agentId: 'agent',
    sourceMessageId: id,
    turnRequestId: id,
    action,
    reason: 'human_tag',
    rootCommandId: id,
    rootSourceMessageId: id,
    agentDepth: 0,
    source: { id, authorId: 'human', body, createdAt: 1, attachments: [] },
  };
}

it.each([false, true])(
  'starts a new source after a terminal process failure without rereading or reviving the old source (arrival during exit: %s)',
  async (arrivesDuringExit) => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-process-intake-'));
    const controller = new AbortController();
    const processes = new AgentProcesses();
    let notify!: (commands?: readonly AgentCommand[]) => void;
    let recover: (() => void) | undefined;
    let serverQueue = [command('original', 'old local body')];
    let crash = true;
    let alive = false;
    let errors = 0;
    const bodies: string[] = [];
    const lifecycle = {
      start: vi.fn(async () => {
        alive = true;
        return 'physical';
      }),
      stop: vi.fn(async () => {
        alive = false;
      }),
      isCurrent: async () => alive,
      isRunning: () => alive,
    };
    const execute = vi.fn(async (name: string, input: { commandId?: string }) => {
      if (name === 'getAgentCommands') return { commandProtocol: 1, commands: [...serverQueue] };
      if (name === 'claimAgentTurn') {
        if (!serverQueue.some(item => item.id === input.commandId)) throw new DaemonApiError('command claim conflict',409,false);
        const commands=serverQueue.filter(item=>item.id===input.commandId);
        serverQueue = serverQueue.filter((item) => item.id !== input.commandId);
        return {commands};
      }
      return {};
    });
    const api = { execute } as unknown as DaemonApiClient;
    const running = runServerCommandIntake({
      api,
      roomId: 'room',
      agentId: 'agent',
      context: new CommandExecutionContext(root),
      signal: controller.signal,
      onWake: (wake) => {
        if (wake) notify = wake;
      },
      onRecovery: (listener) => {
        recover = listener;
      },
      stop: () => undefined,
      onError: () => {
        errors++;
      },
      run: (item) =>
        processes.run('agent', lifecycle, async () => {
          bodies.push(item.source.body);
          if (crash) {
            crash = false;
            alive = false;
            // The real receipt ends this command. A stale push cannot revive it.
            serverQueue = [];
            notify([command('original', 'stale pushed body')]);
            if (arrivesDuringExit) {
              serverQueue.push(command('new-work'));
              notify([command('new-work')]);
            }
            throw new AcpRuntimeExitedError('fixture died mid-turn');
          }
        }),
    });
    try {
      await vi.waitFor(() => expect(errors).toBe(1));
      const readsAfterDeath = execute.mock.calls.filter(
        ([name]) => name === 'getAgentCommands',
      ).length;
      if (!arrivesDuringExit) {
        recover?.();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(lifecycle.start).toHaveBeenCalledOnce();
        expect(execute.mock.calls.filter(([name]) => name === 'getAgentCommands')).toHaveLength(
          readsAfterDeath,
        );
        serverQueue.push(command('new-work'));
        notify([command('new-work')]);
      }
      await vi.waitFor(() =>
        expect(bodies).toEqual(['old local body', 'new-work']),
      );
      expect(lifecycle.start).toHaveBeenCalledTimes(2);
      expect(
        execute.mock.calls.filter(([name]) => name === 'getAgentCommands').length,
      ).toBe(1);
    } finally {
      controller.abort();
      await running;
      await processes.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('acknowledges explicit restart after processes stop without restarting the hosted runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-process-restart-'));
  const controller = new AbortController();
  let stopped = false;
  const execute = vi.fn(async (name: string) => {
    if (name === 'getAgentCommands')
      return { commandProtocol: 1, commands: [command('restart', '', 'restart')] };
    if (name === 'acknowledgeAgentCommand') {
      expect(stopped).toBe(true);
      controller.abort();
    }
    return {};
  });
  try {
    await runServerCommandIntake({
      api: { execute } as unknown as DaemonApiClient,
      roomId: 'room',
      agentId: 'agent',
      context: new CommandExecutionContext(root),
      signal: controller.signal,
      run: async () => {
        throw new Error('restart is not a model turn');
      },
      stop: () => undefined,
      restart: async () => {
        stopped = true;
      },
    });
    expect(execute).toHaveBeenCalledWith(
      'acknowledgeAgentCommand',
      expect.objectContaining({ commandId: 'restart' }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('uses the pushed reconnect snapshot without asking for commands again',async()=>{
  const root=await mkdtemp(join(tmpdir(),'beeline-pushed-reconnect-'));
  const controller=new AbortController();
  let state!:(connected:boolean,capabilities:Record<string,unknown>)=>void;
  let pushed!:(commands:readonly AgentCommand[])=>void;
  const execute=vi.fn(async(name:string)=>name==='getAgentCommands'?{commandProtocol:1,commands:[]}:name==='claimAgentTurn'?{commands:[command('after-drop')]}:{commands:[]});
  const completed:string[]=[];
  const running=runServerCommandIntake({
    api:{execute,liveSubscribe:(...args:unknown[])=>{state=args[3] as typeof state;pushed=args[5] as typeof pushed;return()=>{};}} as unknown as DaemonApiClient,
    roomId:'room',agentId:'agent',context:new CommandExecutionContext(root),signal:controller.signal,
    stop:()=>{},run:async(item)=>{completed.push(item.id);controller.abort();},
  });
  try{
    await vi.waitFor(()=>expect(state).toBeTypeOf('function'));
    state(true,{pushIntake:true,connectionGeneration:0});state(false,{});
    pushed([command('after-drop')]);state(true,{pushIntake:true,connectionGeneration:1});
    await running;
    expect(completed).toEqual(['after-drop']);
    expect(execute.mock.calls.filter(([name])=>name==='getAgentCommands')).toHaveLength(1);
  }finally{controller.abort();await running;await rm(root,{recursive:true,force:true});}
});

it('never falls back to a partial claim when grouped claims are unsupported',async()=>{
  const root=await mkdtemp(join(tmpdir(),'beeline-group-protocol-'));
  const abort=new AbortController(),context=new CommandExecutionContext(root);
  const waiting=[command('first'),command('second')];
  let supported=false, notify:((commands?:readonly AgentCommand[])=>void)|undefined;
  const errors:unknown[]=[];
  const execute=vi.fn(async(name:string)=>{
    if(name==='getAgentCommands')return {commandProtocol:1,commands:waiting};
    if(name==='claimAgentTurn'){
      if(!supported)throw new DaemonApiError('grouped claims unavailable',404,false);
      return {commands:waiting};
    }
    if(name==='releaseAgentTurn')return {commands:[]};
    throw new Error(`Unexpected operation ${name}`);
  });
  const observed:AgentCommand[][]=[];
  const running=runServerCommandIntake({api:{execute} as unknown as DaemonApiClient,roomId:'room',agentId:'agent',context,signal:abort.signal,
    onWake:wake=>{notify=wake;},onError:error=>errors.push(error),stop:()=>{},
    run:async()=>{observed.push([...context.commands]);abort.abort();}});
  try{
    await vi.waitFor(()=>expect(errors.length).toBeGreaterThan(0));
    expect(observed).toEqual([]);
    expect(execute.mock.calls.some(([name])=>name==='claimAgentCommand')).toBe(false);
    supported=true;notify?.(waiting);
    await running;
    expect(observed.map(group=>group.map(item=>item.id))).toEqual([['first','second']]);
  }finally{abort.abort();await running;await rm(root,{recursive:true,force:true});}
});
