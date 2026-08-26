import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MISSION_SCRIPT_SCRATCH_BYTES,
  MissionScriptFailure,
  missionScriptHashMatches,
  missionScriptMountPlan,
  parseMissionScriptOutput,
  runMissionScript,
} from './mission-script.js';

const AGENT = 'a'.repeat(64);
const REPOSITORY = 'github:123456';

describe('mission script boundary', () => {
  it('pins the exact script bytes and refuses a modified script before spawn', async () => {
    const script = 'printf ok';
    const digest = createHash('sha256').update(script).digest('hex');
    expect(missionScriptHashMatches(script, digest)).toBe(true);
    expect(missionScriptHashMatches(`${script}\n`, digest)).toBe(false);
    await expect(
      runMissionScript({
        bwrapPath: '/definitely/not/invoked',
        cwd: process.cwd(),
        repositoryKey: REPOSITORY,
        script: `${script}\n`,
        scriptSha256: digest,
        timeoutSeconds: 1,
        maskPaths: [],
      }),
    ).rejects.toMatchObject<Partial<MissionScriptFailure>>({ code: 'script-hash-mismatch' });
  });

  it('uses a read-only-root plan with only the exact repo and quota scratch writable', () => {
    const plan = missionScriptMountPlan('/tmp/exact-repo', [{ path: '/tmp/secret', kind: 'file' }]);
    expect(plan.readOnly).toEqual([]);
    expect(plan.writable).toEqual(['/tmp/exact-repo']);
    expect(plan.rootWritable).not.toBe(true);
    expect(plan.quotaTmpfs).toEqual([
      expect.objectContaining({
        target: '/tmp/beeline-mission-script',
        maxBytes: MISSION_SCRIPT_SCRATCH_BYTES,
        blockGit: true,
      }),
    ]);
    expect(plan.masks).toEqual([{ path: '/tmp/secret', kind: 'file' }]);
  });

  it('accepts only one bounded typed wake pointer for the exact repository', () => {
    const output = JSON.stringify({
      version: 1,
      status: 'complete',
      wakeAgentPubkey: AGENT,
      repositoryKey: REPOSITORY,
      pointer: 'artifacts/result.json',
    });
    expect(parseMissionScriptOutput(output, REPOSITORY).wake).toEqual({
      agentPubkey: AGENT,
      repositoryKey: REPOSITORY,
      pointer: 'artifacts/result.json',
    });
    expect(() =>
      parseMissionScriptOutput(output.replace(REPOSITORY, 'github:other'), REPOSITORY),
    ).toThrowError(MissionScriptFailure);
    expect(() =>
      parseMissionScriptOutput(output.replace('artifacts/result.json', '../secret'), REPOSITORY),
    ).toThrowError(MissionScriptFailure);
    expect(() => parseMissionScriptOutput(`${output}\n${output}`, REPOSITORY)).toThrowError(
      MissionScriptFailure,
    );
  });

  it('fails closed when the sandbox executable is unavailable', async () => {
    await expect(
      runMissionScript({
        cwd: process.cwd(),
        repositoryKey: REPOSITORY,
        script: 'true',
        scriptSha256: createHash('sha256').update('true').digest('hex'),
        timeoutSeconds: 1,
        maskPaths: [],
      }),
    ).rejects.toMatchObject<Partial<MissionScriptFailure>>({ code: 'sandbox-unavailable' });
  });

  it('discards output emitted after the bounded-output termination starts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-mission-output-'));
    const fakeBwrap = join(root, 'bwrap');
    await writeFile(
      fakeBwrap,
      "#!/bin/sh\ntrap 'printf LATE_AFTER_TERMINATION >&2; exit 0' TERM\nhead -c 70000 /dev/zero | tr '\\0' x\nwhile :; do sleep 1; done\n",
    );
    await chmod(fakeBwrap, 0o755);
    try {
      const script = 'true';
      const error = await runMissionScript({
        bwrapPath: fakeBwrap,
        cwd: process.cwd(),
        repositoryKey: REPOSITORY,
        script,
        scriptSha256: createHash('sha256').update(script).digest('hex'),
        timeoutSeconds: 5,
        maskPaths: [],
      }).catch((failure: unknown) => failure);
      expect(error).toMatchObject<Partial<MissionScriptFailure>>({ code: 'output-truncated' });
      expect((error as MissionScriptFailure).outputTail).not.toContain('LATE_AFTER_TERMINATION');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
