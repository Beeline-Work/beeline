import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
for (const [file, marker, end] of [
 ['members.tsx', 'const invitePerson = async () => {', '\n  };'],
 ['chat/_chat-surface.tsx', 'const handleInvitePerson = useCallback(async () => {', '\n  }, ['],
]) {
 it(`Reproduction 1: ${file} retains the minted link without browser sharing`, async () => {
  const source = readFileSync(`sources/app/(app)/beeline/${file}`, 'utf8');
  const body = source.slice(source.indexOf(marker) + marker.length, source.indexOf(end, source.indexOf(marker)));
  const shown = vi.fn();
  const mint = vi.fn().mockResolvedValue('https://example.test/join/existing');
  const share = vi.fn().mockRejectedValue(new Error('Share is not supported in this browser'));
  const present = async (url: string) => {
    const { sharePersonInvite } = await import('./share-person-invite');
    await sharePersonInvite(url, undefined, shown);
  };
  const vars = { surface: {viewer:{permissions:{manage:true}}},workspaceId:'workspace',relayUrl:'relay',setWorking:vi.fn(),setError:vi.fn(),getBuzzRuntimeConfig:()=>({}),resolveCommunityInvitePublicOrigin:()=>'',createCommunityInviteUrl:mint,writeClient:async()=>({}),Share:{share},presentPersonInvite:present,appErrorCopy:String,activeCommunityId:'workspace',canManageWorkspace:true,memberInviteBusy:false,setMemberInviteBusy:vi.fn(),setMembershipError:vi.fn(),transport:{ensureClient:async()=>({})} };
  await new Function(...Object.keys(vars), `return (async () => {${body}})()`)(...Object.values(vars));
  expect(mint).toHaveBeenCalledTimes(1);
  expect(shown).toHaveBeenCalledWith('https://example.test/join/existing');
 });
}
