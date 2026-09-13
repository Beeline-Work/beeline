#!/usr/bin/env node

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MACOS_SIGNING_CREDENTIALS = Object.freeze([
  'MACOS_APPLE_CERTIFICATE',
  'MACOS_APPLE_CERTIFICATE_PASSWORD',
  'MACOS_APPLE_SIGNING_IDENTITY',
  'MACOS_ASC_KEY_ID',
  'MACOS_ASC_ISSUER_ID',
  'MACOS_ASC_API_KEY_P8',
]);

export const UNSIGNED_MACOS_NOTICE = 'macOS artifact UNSIGNED: signing secrets absent';

export function desktopSigningDecision({ platform, variant, env }) {
  if (platform !== 'macOS') {
    return { enabled: false, missing: [], reason: 'not-macos' };
  }
  if (variant === 'dev') {
    return { enabled: false, missing: [], reason: 'unsigned-variant' };
  }

  const missing = MACOS_SIGNING_CREDENTIALS.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    return {
      enabled: false,
      missing,
      reason: 'credentials-missing',
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
    case 'credentials-missing': {
      const detail = `Missing: ${decision.missing.join(', ')}`;
      console.log(`::warning::${UNSIGNED_MACOS_NOTICE} (${detail})`);
      if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${UNSIGNED_MACOS_NOTICE}\n\n${detail}\n`);
      }
      break;
    }
    case 'credentials-present':
      console.log('::notice::macOS production signing and notarization are enabled');
      break;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
