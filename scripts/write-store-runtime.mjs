import { readFileSync, writeFileSync } from 'node:fs';
const [platform, buildNumber, output] = process.argv.slice(2);
if (!['android', 'ios'].includes(platform) || !/^\d+(\.\d+)*$/.test(buildNumber ?? '')) {
  throw new Error('A platform, exact uploaded build number and output are required');
}
const pin = JSON.parse(readFileSync(new URL('../apps/mobile/native-fingerprint.json', import.meta.url), 'utf8'))[platform].runtimeVersion;
writeFileSync(output, JSON.stringify({ platform, buildNumber, runtimeVersion: pin }) + '\n');
