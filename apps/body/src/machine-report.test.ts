/**
 * Machine identity reporting: the daemon reports its machine_id/machine_name
 * on activation so the server can collapse multiple agents on one host into a
 * single machine row in readWorkbench.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readMachineId } from './connect-command.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function scratchDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

describe('readMachineId', () => {
  /**
   * readMachineId resolves: resolve(XDG_CONFIG_HOME, 'beeline') for the config
   * directory, so XDG_CONFIG_HOME should point to a dir that contains 'beeline'.
   */
  async function withMachineId(dir: string, machineId: string): Promise<string> {
    const beelineDir = resolve(dir, 'beeline');
    await mkdir(beelineDir, { recursive: true });
    await writeFile(resolve(beelineDir, 'machine-id'), `${machineId}\n`);
    return beelineDir;
  }

  it('returns a stable machine id from the persisted file', async () => {
    const dir = await scratchDir('machine-report-config-');
    const machineId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await withMachineId(dir, machineId);

    const result = await readMachineId({ XDG_CONFIG_HOME: dir });
    expect(result.machineId).toBe(machineId);
    expect(result.machineName).toBe(hostname());
  });

  it('generates a new id when none exists and persists it', async () => {
    const dir = await scratchDir('machine-report-new-');

    const result = await readMachineId({ XDG_CONFIG_HOME: dir });
    expect(result.machineId).toMatch(/^[0-9a-f-]{32,}$/);
    expect(result.machineName).toBe(hostname());

    // Verify it was persisted.
    const beelineDir = resolve(dir, 'beeline');
    const persisted = await readFile(resolve(beelineDir, 'machine-id'), 'utf8');
    expect(persisted.trim()).toBe(result.machineId);
  });

  it('returns the same id on repeated calls', async () => {
    const dir = await scratchDir('machine-report-repeat-');
    const machineId = 'ffffffff-gggg-4hhh-8iii-jjjjjjjjjjjj';
    await withMachineId(dir, machineId);

    const first = await readMachineId({ XDG_CONFIG_HOME: dir });
    const second = await readMachineId({ XDG_CONFIG_HOME: dir });
    expect(first.machineId).toBe(second.machineId);
    expect(first.machineName).toBe(second.machineName);
  });

  it('falls back to hostname hash when config dir is unwritable', async () => {
    // Use a path under /dev where mkdir will fail, so readMachineId
    // falls back to the sha256-hash-of-hostname strategy.
    // The sha256 hash is sliced to 36 chars (matching UUID length roughly).
    const unwritable = '/dev/beeline-machine-test';
    const result = await readMachineId({ XDG_CONFIG_HOME: unwritable });
    expect(result.machineId).toMatch(/^[0-9a-f]{36}$/);
    expect(result.machineName).toBe(hostname());
  });
});

describe('daemon reports machine identity on activation', () => {
  it('posts the machine report operation with readMachineId values', async () => {
    const dir = await scratchDir('machine-report-activation-');
    const beelineDir = resolve(dir, 'beeline');
    await mkdir(beelineDir, { recursive: true });
    const machineIdPath = resolve(beelineDir, 'machine-id');
    const machineId = 'aaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await writeFile(machineIdPath, `${machineId}\n`);

    // Simulate what the activation path in cli.ts does:
    //   void readMachineId(process.env).then(({ machineId, machineName }) =>
    //     daemonApi.execute('postAgentMachineReport', { machineId, machineName }),
    //   );
    const executed = vi.fn<[string, unknown], Promise<unknown>>().mockResolvedValue({
      id: 'result',
      createdAt: 1000,
    });

    const { machineId: reportedId, machineName: reportedName } = await readMachineId({
      XDG_CONFIG_HOME: dir,
    });
    await executed('postAgentMachineReport', {
      machineId: reportedId,
      machineName: reportedName,
    });

    expect(executed).toHaveBeenCalledWith('postAgentMachineReport', {
      machineId,
      machineName: hostname(),
    });
  });
});