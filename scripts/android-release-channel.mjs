// EAS channel selection is a build input, not committed native compatibility
// metadata. Inject the next profile only in the release runner's checkout.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function androidReleaseProfile(config, channel) {
  if (!['next', 'latest'].includes(channel)) throw new Error(`invalid Android release channel: ${channel}`);
  if (!config.build?.['production-ci']) throw new Error('missing production-ci Android build profile');
  if (channel === 'latest') return { config, profile: 'production-ci' };
  if (config.build['next-ci']) throw new Error('next-ci must be injected at build time, not committed');
  const candidate = structuredClone(config);
  candidate.build['next-ci'] = { extends: 'production-ci', channel: 'next' };
  return { config: candidate, profile: 'next-ci' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, channel] = process.argv.slice(2);
  const original = JSON.parse(readFileSync(file, 'utf8'));
  const { config, profile } = androidReleaseProfile(original, channel);
  if (config !== original) writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  console.log(profile);
}
