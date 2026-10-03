import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

const scanner = { id: 'b'.repeat(64), name: 'Scanner', kind: 'agent' };
const peer = { id: 'c'.repeat(64), name: 'Peer', kind: 'agent' };
const admin = { id: 'a'.repeat(64), name: 'Admin', kind: 'human' };
const started = {
  workflowSlug: 'daily',
  description: 'Daily scan',
  roomId: 'room',
  roomName: 'Team',
  state: 'scan',
  status: 'live',
  viewerHolds: false,
  startedAt: 1790000000,
  updatedAt: 1790000000,
  earlierRunCount: 0,
};
const contract = {
  version: 1,
  name: 'daily',
  description: 'Daily scan',
  roles: ['scanner'],
  start: 'scan',
  handoffs: {
    scan: { role: 'scanner', requires: [], on: { done: 'done' } },
    done: { kind: 'terminal', status: 'done' },
  },
};
async function proof(
  canTransfer: boolean,
  noOwner = false,
  width = 390,
  transfer = false,
  catalog = false,
) {
  const mobile = process.cwd();
  const detail = {
    contract,
    ownership: {
      owner: noOwner ? null : scanner,
      canTransfer,
      activeRunIds: ['1'.repeat(64)],
      ...(canTransfer ? { ownerCandidates: [scanner, peer] } : {}),
    },
    runs: noOwner
      ? []
      : [
          { ...started, runId: '1'.repeat(64), startedBy: scanner, startKind: 'owner' },
          { ...started, runId: '2'.repeat(64), startedBy: scanner, startKind: 'schedule' },
          { ...started, runId: '3'.repeat(64), startedBy: admin, startKind: 'human_admin' },
        ],
  };
  const response = await runBrowserProof({
    entry: path.join(mobile, 'scripts/workflow-owner-proof.tsx'),
    mobile,
    width,
    query: catalog ? '?catalog=1' : transfer ? '?transfer=1' : '',
    shims: {
      ...webProofShims(mobile),
      'expo-router': `import React from 'react'; export const useFocusEffect = effect => React.useEffect(effect,[effect]);
        export const useLocalSearchParams = () => ({roomId:'room',name:new URLSearchParams(location.search).has('catalog') ? undefined : 'daily'}); export const router = {back:()=>{},push:()=>{}};`,
      '@/sync/transport/monolith-operation': `let detail=${JSON.stringify(detail)};
        export const monolithPhoneOperation = async (name,input) => {
          (globalThis.__calls ??= []).push({name,input});
          if(name==='listWorkflowDefinitions') return {workflows:[{name:'daily',ownership:detail.ownership}]};
          if(name==='transferWorkflowOwner') detail.ownership.owner=${JSON.stringify(peer)};
          return detail; };`,
    },
  });
  expect(response.status, response.stderr).toBe(0);
  expect(response.result.startsWith('{'), response.result).toBe(true);
  const result = JSON.parse(response.result);
  expect(result.overflow).toBe(false);
  return result;
}

describe.skipIf(!existsSync(CHROME))(
  'Workflow ownership in the browser',
  { timeout: 60_000 },
  () => {
    it('shows owner/avatar, authorized control and all three kinds of starter at phone and desktop widths', async () => {
      for (const width of [390, 1280]) {
        const page = await proof(true, false, width);
        expect(page.text).toContain('Owner');
        expect(page.text).toContain('Scanner');
        expect(page.ownerAvatar).toBe(true);
        expect(page.changeOwner).toBe(true);
        expect(page.text).toContain('Scanner · owner');
        expect(page.text).toContain('Schedule (as Scanner)');
        expect(page.text).toContain('Admin · human admin');
        expect(page.text).toContain('1'.repeat(64));
      }
    });
    it('hides Change owner from unauthorized viewers', async () => {
      const page = await proof(false);
      expect(page.changeOwner).toBe(false);
      expect(page.text).not.toContain('Change owner');
    });
    it('shows no-owner warning and assignment only to authorized humans, including before any runs', async () => {
      const adminPage = await proof(true, true);
      expect(adminPage.text).toContain('no owner, starts blocked');
      expect(adminPage.text).toContain('Assign owner');
      expect(adminPage.text).toContain('No runs yet.');
      expect((await proof(false, true)).changeOwner).toBe(false);
    });
    it('selects a Room agent, calls the transfer API and reloads ownership', async () => {
      const page = await proof(true, false, 390, true);
      expect(page.calls).toContainEqual({
        name: 'transferWorkflowOwner',
        input: { roomId: 'room', name: 'daily', ownerId: peer.id },
      });
      expect(page.text).toContain('Peer');
      expect(page.text).not.toContain('Choose an agent');
    });
    it('makes definitions without runs reachable in the workflow catalog', async () => {
      const page = await proof(true, true, 390, false, true);
      expect(page.text).toContain('Workflows');
      expect(page.text).toContain('Daily');
      expect(page.text).toContain('no owner, starts blocked');
      expect(page.calls).toContainEqual({
        name: 'listWorkflowDefinitions',
        input: { roomId: 'room' },
      });
    });
  },
);
