// Run after npm run build. Only fixture values and a short-lived child process.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAgentEnv } from '../apps/body/dist/config.js';
import { authTenantsFromEnvironment } from '../apps/auth/dist/environment.js';

const directory = mkdtempSync(join(tmpdir(), 'beeline-env-proof-'));
try {
  const tenants = [
    {
      host: 'localhost',
      community: 'fixture',
      roomCommunityIds: ['fixture'],
      origin: 'http://localhost',
    },
  ];
  for (const prefix of ['BUZZY_', 'BEELINE_']) {
    const file = join(directory, 'model.env');
    writeFileSync(
      file,
      prefix + 'LLM_API_KEY=fixture-key\n' + prefix + 'LLM_MODEL=fixture-model\n',
    );
    const env = buildAgentEnv(
      {
        [prefix + 'BODY_AGENT_ENV_PASSTHROUGH']: 'PROOF_VALUE',
        PROOF_VALUE: 'fixture-passthrough',
      },
      file,
    );
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict';
      assert.equal(process.env.OPENAI_COMPAT_API_KEY, 'fixture-key');
      assert.equal(process.env.OPENAI_COMPAT_MODEL, 'fixture-model');
      assert.equal(process.env.BEELINE_LLM_MODEL, 'fixture-model');
      assert.equal(process.env.BUZZY_LLM_MODEL, 'fixture-model');
      assert.equal(process.env.PROOF_VALUE, 'fixture-passthrough');
    `,
      ],
      { env, encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(
      authTenantsFromEnvironment({
        [prefix + 'AUTH_TENANTS_JSON']: JSON.stringify(tenants),
      }),
      tenants,
    );
    console.log(
      prefix +
        ': operator file → built helper → real child environment passed; auth tenant config passed',
    );
  }
  const chosen = buildAgentEnv({ BEELINE_LLM_MODEL: 'new', BUZZY_LLM_MODEL: 'old' });
  assert.equal(chosen.BUZZY_LLM_MODEL, 'new');
  assert.equal(chosen.BEELINE_LLM_MODEL, 'new');
  console.log('Both set: Beeline wins for new and legacy child readers');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
