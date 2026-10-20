import test from 'node:test';
import assert from 'node:assert/strict';
import { postNightlyAlert } from './post-nightly-alert.mjs';
test('uses workflow OIDC and the server origin, with one Room delivery per failed report', async () => {
  const requests = [];
  const request = async (url, options) => {
    requests.push({ url: String(url), options });
    return requests.length === 1 ? { ok: true, json: async () => ({ value: 'test-workflow-identity' }) } : { ok: true };
  };
  await postNightlyAlert({ pass: false, text: 'room-list-unseen-5 over budget; #12' }, {
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.githubusercontent.com/request?existing=1',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-request-identity', GITHUB_RUN_ID: '123', LATENCY_RIG_NIGHT: '2026-10-20',
  }, request);
  assert.equal(new URL(requests[0].url).searchParams.get('audience'), 'beeline-latency-rig');
  assert.equal(requests[1].url, 'https://server.usebeeline.app/v1/latency-rig/alert');
  assert.equal(requests[1].options.headers.authorization, 'Bearer test-workflow-identity');
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    night: '2026-10-20', summary: 'room-list-unseen-5 over budget; #12', runId: '123',
  });
  requests.length = 0;
  await postNightlyAlert({ pass: true }, {}, request);
  assert.equal(requests.length, 0);
});
test('does not attempt Room delivery when workflow identity is refused', async () => {
  let requests = 0;
  await assert.rejects(postNightlyAlert({ pass: false }, {
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.githubusercontent.com/request',
  }, async () => { requests++; return { ok: false, status: 403 }; }), /identity unavailable/);
  assert.equal(requests, 1);
});
