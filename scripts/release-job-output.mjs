// Transport public release metadata only. JSON punctuation can match a masked
// line of a multiline credential (run 41175457061 masked even '{' and '}'),
// causing GitHub to silently discard otherwise public JSON job outputs.
// This encoding is not encryption and must never carry credentials.
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function encodeReleaseOutput(value) {
  return `b64:${Buffer.from(JSON.stringify(value)).toString('base64')}`;
}

export function decodeReleaseOutput(value, label = 'release metadata') {
  if (!value?.trim()) throw new Error(`${label}:missing`);
  try {
    let json = value;
    if (value.startsWith('b64:')) {
      const bytes = Buffer.from(value.slice(4), 'base64');
      if (bytes.toString('base64') !== value.slice(4)) throw new Error('invalid encoding');
      json = bytes.toString('utf8');
    }
    const decoded = JSON.parse(json);
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('expected object');
    return decoded;
  } catch {
    throw new Error(`${label}:invalid`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , envName, output] = process.argv;
  try {
    const value = process.env[envName];
    writeFileSync(output, value?.trim() ? JSON.stringify(decodeReleaseOutput(value, envName)) : '');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
