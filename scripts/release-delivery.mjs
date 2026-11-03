#!/usr/bin/env node
// The live checkpoint excludes native builds. Their checks still decide the
// final release outcome; never infer live delivery from a green native build.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeReleaseOutput, decodeReleaseOutput } from './release-job-output.mjs';

export const LIVE_DELIVERY_TARGET_SECONDS = 600;
const LIVE_JOBS = { server: ['server'], 'mobile-ota': ['mobile_ota', 'mobile_ota_after_proof'], website: ['website'] };

export function liveDelivery(needs, { triggerEpoch, finishedEpoch }) {
  const trigger = Number(triggerEpoch);
  const finished = Number(finishedEpoch);
  if (!Number.isSafeInteger(trigger) || trigger <= 0 || !Number.isSafeInteger(finished) || finished < trigger) {
    throw new Error('invalid live delivery clock');
  }
  const plan = needs?.initialize?.outputs;
  if (!plan || needs.initialize.result !== 'success') throw new Error('live delivery requires a successful plan');
  const components = {};
  for (const [component, jobs] of Object.entries(LIVE_JOBS)) {
    const selected = plan[`run_${component.replace('-', '_')}`];
    if (!['true', 'false'].includes(selected)) throw new Error(`missing live selection for ${component}`);
    if (selected === 'false') { components[component] = { state: 'carried' }; continue; }
    const job = jobs.find((name) => needs[name]?.result === 'success');
    const completedAt = Number(needs[job]?.outputs?.completed_at);
    // A successful job with a missing clock is not timing evidence. Do not
    // substitute the result job's start time (it may queue for many minutes).
    if (!job || !Number.isSafeInteger(completedAt) || completedAt < trigger || completedAt > finished) {
      components[component] = { state: 'failure', jobs: Object.fromEntries(jobs.map((name) => [name, needs[name]?.result ?? 'missing'])) };
    } else components[component] = { state: 'success', completedAt, elapsedSeconds: completedAt - trigger };
  }
  const failed = Object.entries(components).filter(([, entry]) => entry.state === 'failure').map(([name]) => name);
  const completions = Object.values(components).flatMap((entry) => entry.completedAt ? [entry.completedAt] : []);
  const completedAt = failed.length ? finished : Math.max(trigger, ...completions);
  const elapsedSeconds = completedAt - trigger;
  return {
    state: failed.length ? 'failure' : 'success', triggerEpoch: trigger, completedAt,
    elapsedSeconds, targetSeconds: LIVE_DELIVERY_TARGET_SECONDS,
    withinTarget: failed.length === 0 && elapsedSeconds < LIVE_DELIVERY_TARGET_SECONDS,
    components,
  };
}

export function recordDelivery(state, needs) {
  const value = needs.delivery_result?.outputs?.report;
  if (!value) throw new Error('missing live delivery report');
  const live = decodeReleaseOutput(value, 'live delivery');
  if (!['success', 'failure'].includes(live.state)) throw new Error('invalid live delivery report');
  state.delivery.live = live;
  state.delivery.background = Object.fromEntries(
    ['helper_linux', 'helper_macos', 'helper', 'desktop_installers', 'mobile_native_android', 'mobile_native_ios']
      .map((name) => [name, needs[name]?.result ?? 'missing']),
  );
  return state;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, path] = process.argv.slice(2);
  const needs = JSON.parse(process.env.NEEDS);
  if (command === 'measure') {
    const report = liveDelivery(needs, { triggerEpoch: process.env.TRIGGER_EPOCH, finishedEpoch: Math.floor(Date.now() / 1000) });
    appendFileSync(process.env.GITHUB_OUTPUT, `report=${encodeReleaseOutput(report)}\n`);
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Live delivery: ${report.state}\n\nDispatch to server (both Machines), phone OTA and website: **${report.elapsedSeconds}s** (target <${report.targetSeconds}s).\n\nNative/helper completion is recorded separately; every selected component must still pass before the release is finalized.\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`);
    if (report.state !== 'success') process.exitCode = 1;
  } else if (command === 'record') {
    writeFileSync(path, `${JSON.stringify(recordDelivery(JSON.parse(readFileSync(path, 'utf8')), needs), null, 2)}\n`);
  } else throw new Error(`unknown delivery command: ${command}`);
}
