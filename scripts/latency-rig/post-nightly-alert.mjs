#!/usr/bin/env node
/** Use the workflow's short-lived GitHub identity; no stored Room credential. */
import { readFile } from 'node:fs/promises';
const report = JSON.parse(await readFile(process.argv[2] ?? 'latency-rig-output/nightly.json', 'utf8'));
if (report.pass) process.exit(0);
const identityUrl = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
identityUrl.searchParams.set('audience', 'beeline-latency-rig');
const identity = await fetch(identityUrl, {
  headers: { authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
  signal: AbortSignal.timeout(10_000),
});
if (!identity.ok) throw new Error(`Workflow identity unavailable: HTTP ${identity.status}`);
const { value } = await identity.json();
if (typeof value !== 'string' || !value) throw new Error('Workflow identity missing');
const response = await fetch('https://usebeeline.app/v1/latency-rig/alert', {
  method: 'POST', headers: { authorization: `Bearer ${value}`, 'content-type': 'application/json' },
  body: JSON.stringify({ night: process.env.LATENCY_RIG_NIGHT ?? new Date().toISOString().slice(0, 10),
    summary: report.text, runId: process.env.GITHUB_RUN_ID }),
  signal: AbortSignal.timeout(15_000),
});
if (!response.ok) throw new Error(`Room alert failed: HTTP ${response.status}`);
console.log('Nightly alert accepted for the Beeline Room');
