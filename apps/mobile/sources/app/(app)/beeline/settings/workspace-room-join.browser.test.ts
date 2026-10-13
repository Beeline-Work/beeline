import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

const WORKSPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FANTASTIK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GENERAL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const VIEWER = 'a'.repeat(64);

function shims(mobile: string): Record<string, string> {
  const generalRoom = `{ id: '${GENERAL}', workspaceId: '${WORKSPACE}', name: 'general',
    visibility: 'public', archived: false, createdAt: 1700000000, updatedAt: 1700000000 }`;
  return {
    ...webProofShims(mobile),
    'expo-router': `import React from 'react';
    export const router = { back: () => undefined, replace: () => undefined,
      push: (href) => { (globalThis.__pushed ??= []).push(href); } };
    export const useFocusEffect = (effect) => React.useEffect(effect, [effect]);
    export const useLocalSearchParams = () => ({ communityId: '${WORKSPACE}' });
    export const useRouter = () => ({ back: () => undefined, push: () => undefined });`,
    '@/modal': `export const Modal = { actionSheet: async () => undefined, alert: async () => undefined,
      confirm: async () => false };`,
    '@/auth/buzz-identity-storage': `export const getEffectiveRelayUrl = async () => 'https://relay.test';
    export const loadBuzzViewerPubkey = async () => '${VIEWER}';
    export const loadBuzzIdentity = async () => ({ publicKey: '${VIEWER}', secretKey: new Uint8Array(32) });`,
    '@/buzz/avatar-upload': 'export const pickAndUploadAvatar = async () => undefined;',
    '@/buzz/runtime-config':
      "export const getBuzzRuntimeConfig = () => ({ monolithEnabled: true, relayUrl: 'https://relay.test' });",
    '@/sync/transport': `export class BuzzRigTransport {
      async ensureClient() { return { surfaceSubscribe: async () => () => undefined }; }
    }`,
    '@/sync/transport/live-connection': `export const sharedLiveConnection = () => ({
      register: async () => () => undefined, whenSubscribed: async () => undefined,
      isViewing: () => false, reconnect: () => undefined,
    });`,
    '@/sync/transport/monolith-operation': `export const monolithPhoneOperation = async (name, input) => {
      (globalThis.__inputs ??= []).push([name, input]);
      if (name === 'addRoomMember') return { joined: true };
      if (name === 'createInvite') return { token: 'proof-token' };
      return undefined;
    };`,
    // The owner sees #general (joined) and fantastik (invite-only, not joined).
    '@/sync/transport/room-view-client': `export class RoomViewClient {
      async workspace() {
        return {
          workspace: { id: '${WORKSPACE}', name: 'TBing Crew', visibility: 'invite-only', createdAt: 1700000000 },
          viewer: {
            identity: { pubkey: '${VIEWER}', kind: 'human', name: 'Owner' },
            role: 'owner',
            permissions: { send: true, manage: true },
          },
          managerSettings: {
            visibility: 'invite-only',
            rooms: [
              { id: '${FANTASTIK}', name: 'fantastik', visibility: 'invite-only', createdAt: 1700000000 },
              { id: '${GENERAL}', name: 'general', visibility: 'public', createdAt: 1700000000 },
            ],
          },
          peopleTotal: 1, agentTotal: 0,
        };
      }
      async chats() {
        return {
          workspace: { id: '${WORKSPACE}', name: 'TBing Crew', visibility: 'invite-only', role: 'owner', updatedAt: 1 },
          viewer: { pubkey: '${VIEWER}', kind: 'human', name: 'Owner' },
          chats: [{ room: ${generalRoom}, memberCount: 1, cornerCount: 0, unread: false }],
          truncated: false,
          watchFilters: [],
        };
      }
    }`,
  };
}

type Proof = {
  rows: { fantastik: string[] | null; general: string[] | null };
  afterRowTap: { operations: [string, unknown][]; sheet: string[] | null };
  afterJoin: { operations: [string, unknown][]; pushed: unknown[] } | null;
};

// Reproduction R1: tapping an unjoined invite-only Room flipped it to Public.
describe.skipIf(!existsSync(CHROME))('Workspace settings: join a Room (R1)', () => {
  it('opens a sheet on row tap, then joins and opens the Room', async () => {
    const mobile = process.cwd();
    const { result, status, stderr } = await runBrowserProof({
      entry: path.join(mobile, 'scripts/workspace-room-join-proof.tsx'),
      mobile,
      shims: shims(mobile),
      width: 390,
      height: 844,
    });
    expect(status, stderr).toBe(0);
    if (process.env.PRINT_PROOF) console.log(result);
    expect(result.startsWith('{'), result).toBe(true);
    const proof = JSON.parse(result) as Proof;

    expect(proof.rows.fantastik).toEqual(['#fantastik', 'Not joined', 'Invite-only']);
    expect(proof.rows.general).toEqual(['#general', 'Public']);
    // The row tap changes nothing on the server; it opens the Room sheet.
    expect(proof.afterRowTap.operations.filter(([name]) => name === 'updateRoom')).toEqual([]);
    expect(proof.afterRowTap.sheet).toEqual(
      expect.arrayContaining([
        '#fantastik',
        'Invite-only · you are not a member',
        'Join room',
        'Make Public',
        'Copy Room ID',
        'Cancel',
      ]),
    );
    expect(proof.afterJoin?.operations).toContainEqual([
      'addRoomMember',
      { roomId: FANTASTIK, memberId: VIEWER },
    ]);
    expect(proof.afterJoin?.pushed).toEqual([
      { pathname: '/beeline/chat/[channelId]', params: { channelId: FANTASTIK, communityId: WORKSPACE } },
    ]);
  }, 120_000);
});
