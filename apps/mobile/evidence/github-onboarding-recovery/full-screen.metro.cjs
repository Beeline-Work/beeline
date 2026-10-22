const fs = require('fs');
const path = require('path');
// The original config is copied next to this file only for the proof build.
const config = require('../../metro.product.cjs');
const original = config.resolver.resolveRequest;
const dir = path.resolve(__dirname, '../../.scratch/full-screen-proof');
fs.mkdirSync(dir, { recursive: true });
const none = 'async () => null';
const shims = {
  '@/buzz/onboarding-rollout': 'export const useRepositoryOnboarding=()=>true; export const readRepositoryOnboardingEligibility=async()=>true;',
  '@/buzz/latency-route-hook': 'export const useLatencyRouteFrame=()=>{};',
  '@/buzz/use-text-draft': "export const useTextDraft=()=>['',()=>{},{clear:()=>{}}];",
  '@/auth/signin-funnel': 'export const beginFunnelAttempt=async()=>null; export const pendingFunnelAttempt=async()=>null; export const funnelScreen=async()=>{}; export const funnelCallback=async()=>{};',
  '@/auth/google-auth-session': 'export const clearPendingGoogleSignIn=async()=>{}; export const resumeGoogleSignIn=async()=>null; export const runGoogleSignIn=async()=>null;',
  '@/auth/buzz-identity-storage': `export const clearPendingGitHubIdentity=${none}; export const loadBuzzIdentity=${none}; export const loadPendingGitHubIdentity=${none};`,
  '@/auth/github-auth-session': `import {OidcBindError} from '@beeline/buzz-client'; export const clearPendingGitHubSignInState=${none}; export const cancelPendingGitHubSignIn=${none}; export const isPendingGitHubReconnect=async()=>false; export const loadPendingGitHubBindChallenge=${none}; export const recoverPendingGitHubBindChallenge=${none}; export const resumeInitialGitHubSignIn=${none}; export const runResilientGitHubSignInSession=async()=>{throw new OidcBindError('offline','offline');};`,
  '@/auth/monolith-session': 'export class GitHubAccountMismatchError extends Error {} export const monolithSession={identityId:async()=>null};',
  '@/auth/desktop-auth-session': `export const initialAuthUrl=${none}; export const openAccountAuthSession=${none}; export const subscribeToAuthUrls=()=>({remove(){}});`,
  '@/buzz/person-name': `export const clearPersonNameOnboardingPending=${none}; export const loadPreferredPersonName=${none}; export const markPersonNameOnboardingPending=${none}; export const resolveOnboardingPersonName=${none}; export const savePreferredPersonName=${none};`,
  '@/buzz/runtime-config': "export const getBuzzRuntimeConfig=()=>({relayUrl:'https://example.invalid',monolithUrl:'https://example.invalid'});",
  '@/push/buzz-push-registration': `export const registerBuzzPushNotifications=${none};`,
  '@/sync/transport': 'export class BuzzRigTransport {}',
  '@/sync/transport/monolith-operation': 'export const monolithPhoneOperation=async()=>({});',
};
const files = {};
for (const [name, source] of Object.entries(shims)) {
  const file = path.join(dir, `${Object.keys(files).length}.js`);
  fs.writeFileSync(file, source);
  files[name] = file;
}
config.resolver.resolveRequest = (context, name, platform) => {
  const key = Object.keys(files).find(key => name === key || name.endsWith(key.slice(1)) || name.endsWith(key.slice(1) + '.ts'));
  if (key) return { type: 'sourceFile', filePath: files[key] };
  return original ? original(context, name, platform) : context.resolveRequest(context, name, platform);
};
config.maxWorkers = 2;
module.exports = config;
