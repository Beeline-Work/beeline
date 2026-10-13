import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { MachineControl, machineControlPath, requestMachine } from './machine-control.js';
import { readMachineStatus, type HelperStatusFile } from './helper-status.js';
it('ignores stale and malformed disk evidence; only a live connection acknowledges readiness', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-generation-'));
  try {
    await mkdir(resolve(root, 'beeline/helper'), { recursive: true });
    await writeFile(
      resolve(root, 'beeline/helper/status.json'),
      JSON.stringify({ pid: process.pid, generation: 'stale', agents: {} }),
    );
    await expect(requestMachine(root, { operation: 'status' }, () => true, 20)).rejects.toThrow(
      'no live helper acknowledgment',
    );
    const control = new MachineControl(machineControlPath(root), async () => undefined);
    await control.start();
    const status: HelperStatusFile = {
      pid: process.pid,
      generation: 'current',
      processState: 'serving',
      loadedRelease: 'current',
      updatedAt: new Date().toISOString(),
      agents: {},
    };
    control.publish(status);
    try {
      await writeFile(resolve(root, 'beeline/helper/status.json'), '{broken');
      expect((await readMachineStatus({ XDG_STATE_HOME: root }))?.generation).toBe('current');
    } finally {
      await control.stop();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('readiness observes a scoped stop completion event, without rereading a status file', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-scoped-stop-'));
  const control = new MachineControl(machineControlPath(root), async () => undefined);
  await control.start();
  const status: HelperStatusFile = {
    pid: process.pid,
    generation: 'current',
    processState: 'serving',
    updatedAt: new Date().toISOString(),
    agents: { bee: { state: 'serving', status: '', since: 'now' } },
  };
  control.publish(status);
  try {
    let completed = false;
    const pending = requestMachine(
      root,
      { operation: 'stop', agentId: 'bee' },
      (snapshot) => snapshot.agents.bee?.state === 'stopped',
      1000,
    ).then(() => {
      completed = true;
    });
    await new Promise((done) => setTimeout(done, 10));
    expect(completed).toBe(false);
    control.publish({
      ...status,
      agents: { bee: { state: 'stopped', status: 'explicit stop', since: 'later' } },
    });
    await pending;
    expect(completed).toBe(true);
  } finally {
    await control.stop();
    await rm(root, { recursive: true, force: true });
  }
});

it('refuses a malformed live acknowledgment even when its PID belongs to this process', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-invalid-generation-'));
  const control = new MachineControl(machineControlPath(root), async () => undefined);
  await control.start();
  control.publish({
    pid: process.pid,
    generation: '',
    processState: 'serving',
    agents: {},
    updatedAt: 'now',
  });
  try {
    await expect(requestMachine(root, { operation: 'status' }, () => true, 1000)).rejects.toThrow(
      'invalid helper acknowledgment',
    );
  } finally {
    await control.stop();
    await rm(root, { recursive: true, force: true });
  }
});
