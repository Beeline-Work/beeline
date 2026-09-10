import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const NPM_VISIBILITY_TIMEOUT_MS = 5 * 60_000;
export const NPM_VIEW_TIMEOUT_MS = 20_000;
const MAX_BACKOFF_MS = 60_000;
const PUBLIC_NPM_REGISTRY = 'https://registry.npmjs.org';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function isNotFound(result) {
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return /^npm (?:error|ERR!) code E404$/im.test(output);
}

function resultDetail(result) {
  if (result.error) return result.error.message;
  return (result.stderr || result.stdout || `exit status ${result.status}`).trim();
}

export function lookupPublicNpmPackage({ packageName, version, timeoutMs }) {
  return spawnSync(
    'npm',
    [
      'view',
      `${packageName}@${version}`,
      'version',
      `--registry=${PUBLIC_NPM_REGISTRY}`,
      '--fetch-retries=0',
      `--fetch-timeout=${timeoutMs}`,
    ],
    {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, NPM_CONFIG_JSON: 'false', NPM_CONFIG_UPDATE_NOTIFIER: 'false' },
    },
  );
}

export async function waitForNpmPackageVisibility({
  packageName,
  version,
  timeoutMs = NPM_VISIBILITY_TIMEOUT_MS,
  commandTimeoutMs = NPM_VIEW_TIMEOUT_MS,
  initialBackoffMs = 5_000,
  lookup = lookupPublicNpmPackage,
  now = Date.now,
  sleep = delay,
}) {
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let attempts = 0;
  let backoffMs = initialBackoffMs;

  while (now() < deadline) {
    const remainingMs = deadline - now();
    attempts += 1;
    const result = await lookup({
      packageName,
      version,
      timeoutMs: Math.min(commandTimeoutMs, remainingMs),
    });

    if (result.status === 0) {
      const visibleVersion = result.stdout.trim();
      if (visibleVersion !== version) {
        throw new Error(
          `npm view returned unexpected version metadata: ${JSON.stringify(visibleVersion)}`,
        );
      }
      return { attempts, elapsedMs: now() - startedAt };
    }

    if (!isNotFound(result)) {
      throw new Error(`npm view failed: ${resultDetail(result)}`);
    }

    const waitMs = Math.min(backoffMs, deadline - now());
    if (waitMs <= 0) break;
    await sleep(waitMs);
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  }

  throw new Error(`${packageName}@${version} was not visible after ${timeoutMs}ms`);
}

async function main() {
  const [packageName, version] = process.argv.slice(2);
  if (!packageName || !version) {
    throw new Error('usage: npm-package-visibility <package> <version>');
  }

  const result = await waitForNpmPackageVisibility({ packageName, version });
  console.log(
    `${packageName}@${version} is visible on public npm after ${result.attempts} attempt(s)`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
