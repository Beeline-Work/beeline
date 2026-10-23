const fs = require('fs');
const path = require('path');
const config = require('../../metro.config');
const original = config.resolver.resolveRequest;
const dir = path.resolve(__dirname, '../../.scratch/installation-resume-proof');
fs.mkdirSync(dir, { recursive: true });
// Only external browser and server boundaries are stand-ins. The card, auth
// session, native storage, return monitor and cold-resume code are production.
const shims = {
  '@/buzz/onboarding-rollout': 'export const useRepositoryOnboarding=()=>true;',
  'expo-router': 'export const useLocalSearchParams=()=>({});',
  '@/auth/desktop-auth-session': `export const subscribeToAuthUrls=()=>({remove(){}}); export const openAccountAuthSession=async()=> globalThis.proofCancel ? {type:'dismiss'} : {type:'success',url:'beeline://beeline/github-installation?installed=1'};`,
  '@/sync/transport/monolith-operation': `export const monolithPhoneOperation=async(_operation,input)=> input.action==='refresh' ? {} : {url:'https://github.com/apps/beeline/installations/select_target'};`,
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
