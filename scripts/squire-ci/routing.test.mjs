import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { parse } from 'yaml';

const workflow = parse(readFileSync(new URL('../../.github/workflows/checks.yml', import.meta.url), 'utf8'));
const overflow = Object.values(workflow.jobs).filter(job => job['runs-on']?.includes('squire-ci'));
test('server shards fit overflow memory with one worker and retain hosted concurrency', () => {
  const step = workflow.jobs['server-suite-shard'].steps.find(step => step.name === 'Run the server suite shard');
  const expression = step.env.SERVER_TEST_WORKERS.slice(3, -2);
  for (const [environment, expected] of [['self-hosted', '1'], ['github-hosted', '2']]) {
    assert.equal(runInNewContext(expression, { runner: { environment } }), expected);
  }
  assert.ok(step.run.includes('--maxWorkers="$SERVER_TEST_WORKERS" --minWorkers="$SERVER_TEST_WORKERS"'));
});
test('overflow jobs exclude forks, dispatch, pushes, missing PRs and disabled overflow', () => {
  assert.ok([0, 9].includes(overflow.length), 'routing is entirely enabled or reverted');
  for (const job of overflow) {
    const expression = job['runs-on'].slice(3, -2);
    const evaluate = (event, head, disabled = '') => runInNewContext(expression, {
      vars: { SQUIRE_CI_DISABLED: disabled },
      github: { event_name: event, repository: 'Beeline-Work/beeline', event: {
        pull_request: { head: { repo: { full_name: head } } },
      } },
    });
    assert.equal(evaluate('pull_request', 'Beeline-Work/beeline'), 'squire-ci');
    assert.equal(evaluate('pull_request', 'someone/fork'), 'ubuntu-latest');
    assert.equal(evaluate('pull_request', ''), 'ubuntu-latest');
    for (const event of ['push', 'workflow_dispatch', 'pull_request_target', 'merge_group']) {
      assert.equal(evaluate(event, 'Beeline-Work/beeline'), 'ubuntu-latest');
    }
    assert.equal(evaluate('pull_request', 'Beeline-Work/beeline', 'true'), 'ubuntu-latest');
  }
});
