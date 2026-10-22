import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof } from './browserProof';
import { identitySettingsProofShims } from './identitySettingsProofShims';

describe.skipIf(!existsSync(CHROME))('onboarding account settings', () => {
  it.each([false,true])('R-onb-10/11: opens GitHub from Google and explains an existing-account conflict (%s)', async conflict => {
    const mobile = process.cwd();
    const directory = await mkdtemp(path.join(mobile, 'sources/test/onboarding-settings-proof-'));
    const output = process.env.ONBOARDING_EVIDENCE_DIR ?? '/tmp/jellybean-onboarding';
    mkdirSync(output, { recursive: true });
    try {
      const entry = path.join(directory, 'proof.jsx');
      await writeFile(entry, `import React from 'react'; import {createRoot} from 'react-dom/client';
        import Settings from '@/app/(app)/beeline/settings/identity';
        createRoot(document.getElementById('root')).render(<Settings/>);
        setTimeout(async()=>{
          const button=document.querySelector('[data-testid="settings-provider-github"]');
          if(!button){document.getElementById('result').textContent='NOT RENDERED';return;}
          const recovery=document.querySelector('[data-testid="push-retry-registration"]');
          const recoveryText=recovery?.parentElement?.textContent;
          button.click();
          setTimeout(()=>{
            document.getElementById('result').textContent=JSON.stringify({
              began:window.__began??0, refreshed:window.__refreshed??false,
              recoveryText, error:document.body.textContent.includes('Invalid GitHub installation return path'),
              conflict:document.body.textContent.includes('belongs to another Beeline account'),
              providers:window.__providers,
              overflow:[...document.querySelectorAll('div')].filter(n=>n.clientWidth>0&&n.scrollWidth>n.clientWidth+1).map(n=>({id:n.dataset.testid,client:n.clientWidth,scroll:n.scrollWidth})) });
          },400);
        },900);`);
      const shims = identitySettingsProofShims(mobile);
      delete shims['@/components/buzz/IdentityMark'];
      delete shims['@/components/buzz/SettingsRow'];
      delete shims['@/components/buzz/PushLevelSetting'];
      delete shims['@/push/buzz-push-status'];
      delete shims['@/auth/github-auth-session'];
      shims['expo-linking'] = `export const createURL=path=>'https://web.usebeeline.app/'+path;`;
      shims['@react-native-async-storage/async-storage'] = `const map=new Map(); export default {
        getItem:async k=>map.get(k)??null, setItem:async(k,v)=>{map.set(k,v)},removeItem:async k=>{map.delete(k)}};`;
      shims['@/auth/github-installation-host'] = `import {runGitHubInstallationSession,githubInstallationRedirectUri} from '@/auth/github-auth-session';
        export const runHostGitHubInstallationSession=input=>runGitHubInstallationSession({...input,
          openAuthSession:async()=>({type:'success',url:githubInstallationRedirectUri()+'?installed=${conflict ? '0&error=github_account_already_linked' : '1'}'}),
          subscribeToUrls:()=>({remove(){}}),subscribeToAppState:()=>({remove(){}})});`;
      shims['@/push/buzz-push-registration'] = `export const getBuzzPushEnabled=async()=>true;
        export const getBuzzPushRegistrationState=async()=>({registered:false,phase:'network-failed',retryable:true});
        export const registerBuzzPushNotifications=async()=>({registered:false,phase:'network-failed',retryable:true});
        export const setBuzzPushEnabled=async()=>({registered:false,phase:'network-failed',retryable:true});`;
      shims['@/sync/transport/monolith-operation'] = `window.__providers=[{provider:'google',login:'qa@example.test',reconnect:false}];
        const profile=()=>({personId:'a'.repeat(64),name:'Google Person',handle:'googleperson',face:'fox',pushLevel:'attention',providers:window.__providers});
        export const monolithPhoneOperation=async name=>{
          if(name==='readIdentitySettings')return {identity:profile(),workspaces:{workspaces:[],viewer:{pubkey:'a'.repeat(64),kind:'human',name:'Google Person'}}};
          if(name==='getManagedIdentity')return profile();
          if(name==='beginGitHubInstallation'){window.__began=(window.__began??0)+1;return {url:'https://github.com/apps/beeline/installations/new?state=fixture'};}
          if(name==='listGitHubRepositories'){window.__refreshed=true;window.__providers=[...window.__providers,{provider:'github',login:'qa-github',reconnect:false}];return {repositories:[]};}
        };`;
      const fonts = ['SpaceGrotesk-Regular','SpaceGrotesk-Medium','SpaceGrotesk-SemiBold','IBMPlexMono-Regular'].map(font=>
        `@font-face{font-family:'${font}';src:url(data:font/ttf;base64,${readFileSync(path.join(mobile,'sources/assets/fonts',font+'.ttf')).toString('base64')})}`).join('');
      const result = await runBrowserProof({ entry, mobile, shims, width:390, height:1100,
        screenshotPath:path.join(output,conflict?'settings-conflict.png':'settings.png'),
        head:`<style>${fonts}html,body,#root{height:100%;width:390px}#result{display:none}</style>`,budgetMs:5000 });
      expect(result.status,result.stderr).toBe(0);
      const proof = JSON.parse(result.result);
      console.log(JSON.stringify(proof));
      expect(proof.began).toBe(1);
      expect(proof.refreshed).toBe(!conflict);
      expect(proof.error).toBe(false);
      expect(proof.conflict).toBe(conflict);
      expect(proof.overflow).toEqual([]);
      expect(proof.providers.map((p:any)=>p.provider)).toEqual(conflict?['google']:['google','github']);
      expect(proof.recoveryText).toContain('Retry notifications');
      expect(proof.recoveryText).toContain('network error reaching the push gateway');
    } finally {await rm(directory,{recursive:true,force:true});}
  }, 120_000);
});
