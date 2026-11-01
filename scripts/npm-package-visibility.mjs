import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const NPM_VISIBILITY_TIMEOUT_MS = 5 * 60_000;
export const NPM_VIEW_TIMEOUT_MS = 20_000;
const PUBLIC_NPM_REGISTRY = 'https://registry.npmjs.org';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function npmVisibilityTimeoutMs(env = process.env) {
  const value = env.NPM_VISIBILITY_TIMEOUT_MS;
  if (value === undefined) return NPM_VISIBILITY_TIMEOUT_MS;
  const timeoutMs = Number(value);
  if (!value.trim() || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('NPM_VISIBILITY_TIMEOUT_MS must be a positive integer in milliseconds');
  }
  return timeoutMs;
}

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
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
      env: { ...process.env, NPM_CONFIG_JSON: 'false', NPM_CONFIG_UPDATE_NOTIFIER: 'false' },
    },
  );
}

export async function waitForNpmPackageVisibility({
  packageName,
  version,
  timeoutMs = npmVisibilityTimeoutMs(),
  commandTimeoutMs = NPM_VIEW_TIMEOUT_MS,
  retryIntervalMs = 10_000,
  lookup = lookupPublicNpmPackage,
  now = Date.now,
  sleep = delay,
  log = console.log,
}) {
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let attempts = 0;

  log(`Waiting up to ${timeoutMs}ms for ${packageName}@${version} on ${PUBLIC_NPM_REGISTRY}`);

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

    const waitMs = Math.min(retryIntervalMs, deadline - now());
    if (waitMs <= 0) break;
    log(`${packageName}@${version}: npm returned E404 (attempt ${attempts}, ${now() - startedAt}ms elapsed); retrying in ${waitMs}ms`);
    await sleep(waitMs);
  }

  throw new Error(`${packageName}@${version} was not visible after ${timeoutMs}ms (${attempts} attempts) on ${PUBLIC_NPM_REGISTRY}; verify npm publication succeeded before retrying the release`);
}

export async function checkNpmPackageVisibility(options, { warn = false, log = console.log } = {}) {
  try {
    const result = await waitForNpmPackageVisibility(options);
    log(`${options.packageName}@${options.version} is visible on public npm after ${result.attempts} attempt(s)`);
    return 0;
  } catch (error) {
    if (!warn) throw error;
    log(`::warning::${error.message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}`);
    return 0;
  }
}

async function main() {
  const [packageName, version] = process.argv.slice(2);
  if (!packageName || !version) {
    throw new Error('usage: npm-package-visibility <package> <version>');
  }

  process.exitCode = await checkNpmPackageVisibility({ packageName, version }, { warn: process.argv.includes('--warn') });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
