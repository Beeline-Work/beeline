import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { runBrowserProof, webProofShims } from '@/test/browserProof';
for (const appearance of ['bone', 'obsidian']) for (const [file, marker, end] of [
 ['members.tsx', 'const invitePerson = async () => {', '\n  };'],
 ['chat/_chat-surface.tsx', 'const handleInvitePerson = useCallback(async () => {', '\n  }, ['],
]) it(`Reproduction 1 browser ${file} ${appearance}`, async () => {
 const mobile = process.cwd();
 const baseline = process.env.INVITE_BASELINE === '1';
 const source = baseline ? execFileSync('git', ['show', `origin/main:apps/mobile/sources/app/(app)/beeline/${file}`], {encoding:'utf8'}) : readFileSync(`sources/app/(app)/beeline/${file}`, 'utf8');
 const body = source.slice(source.indexOf(marker)+marker.length, source.indexOf(end, source.indexOf(marker)));
 const shims = webProofShims(mobile);
 shims['react-native-unistyles'] = shims['react-native-unistyles'].replace('beelineThemes.obsidian', `beelineThemes.${appearance}`);
 shims['@/modal'] = 'export const Modal = {show: ({component, props}) => globalThis.showInvite(component, props)};';
 shims['invite-handler-proof'] = `import { Share } from 'react-native'; import { presentPersonInvite } from '@/components/buzz/PersonInviteSheet';
 const surface={viewer:{permissions:{manage:true}}},workspaceId='workspace',relayUrl='relay',activeCommunityId='workspace',canManageWorkspace=true,memberInviteBusy=false;
 const setWorking=()=>{},setError=(e)=>{document.getElementById('root').textContent=e},setMembershipError=(e)=>{document.getElementById('root').textContent=e},setMemberInviteBusy=()=>{},getBuzzRuntimeConfig=()=>({}),resolveCommunityInvitePublicOrigin=()=>'',writeClient=async()=>({}),transport={ensureClient:async()=>({})},appErrorCopy=String;
 const createCommunityInviteUrl=async()=> 'https://example.test/join/existing';
 export const runInvite=async()=>{${body}};`;
 const proof = await runBrowserProof({mobile,shims,width:900,entry:path.join(mobile,'scripts/person-invite-proof.tsx'),head: `<style>#result{display:none}#root{max-width:480px;margin:40px auto}body{background:${appearance==='bone'?'#F3EEE4':'#14091A'}}${['SpaceGrotesk-Regular','SpaceGrotesk-Medium','SpaceGrotesk-SemiBold'].map(name=>`@font-face{font-family:'${name}';src:url(data:font/ttf;base64,${readFileSync(path.join(mobile,'sources/assets/fonts',name+'.ttf')).toString('base64')})}`).join('')}</style>`,screenshotPath:`/tmp/beeline-teardown-evidence/invite-${baseline?'before':'after'}-${file.startsWith('chat')?'room':'members'}-${appearance}.png`});
 expect(proof.status,proof.stderr).toBe(0);
 expect(JSON.parse(proof.result)).toEqual({link:'https://example.test/join/existing',copy:true,email:true});
},120000);
