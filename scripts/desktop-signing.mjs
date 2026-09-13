#!/usr/bin/env node

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MACOS_SIGNING_CREDENTIALS = Object.freeze([
  'MACOS_APPLE_CERTIFICATE',
  'MACOS_APPLE_CERTIFICATE_PASSWORD',
  'MACOS_ASC_KEY_ID',
  'MACOS_ASC_ISSUER_ID',
  'MACOS_ASC_API_KEY_P8',
]);

export function desktopSigningDecision({ platform, variant, required, env }) {
  if (platform !== 'macOS') {
    return { enabled: false, missing: [], reason: 'not-macos' };
  }
  if (variant !== 'production') {
    return { enabled: false, missing: [], reason: 'unsigned-variant' };
  }

  const missing = MACOS_SIGNING_CREDENTIALS.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    return {
      enabled: false,
      missing,
      reason: required ? 'required-credentials-missing' : 'optional-credentials-missing',
    };
  }

  return { enabled: true, missing: [], reason: 'credentials-present' };
}

function emitOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  } else {
    console.log(`${name}=${value}`);
  }
}

function main() {
  const decision = desktopSigningDecision({
    platform: process.env.RUNNER_OS,
    variant: process.env.VARIANT,
    required: process.env.REQUIRE_MACOS_SIGNING === 'true',
    env: process.env,
  });

  emitOutput('enabled', String(decision.enabled));

  switch (decision.reason) {
    case 'not-macos':
      console.log('::notice::macOS signing is not applicable on this runner');
      break;
    case 'unsigned-variant':
      console.log(`::notice::${process.env.VARIANT} macOS builds are intentionally unsigned`);
      break;
    case 'optional-credentials-missing':
      console.log(
        `::warning::macOS production signing skipped because credentials are unavailable: ${decision.missing.join(', ')}`,
      );
      break;
    case 'required-credentials-missing':
      console.error(
        `::error::a released macOS artifact must be signed and notarized; missing: ${decision.missing.join(', ')}`,
      );
      process.exitCode = 1;
      break;
    case 'credentials-present':
      console.log('::notice::macOS production signing and notarization are enabled');
      break;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
