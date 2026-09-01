#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

export const RELEASE_COMPONENTS = ['server', 'daemon', 'app'];
const VERSION = /^v(\d+)\.(\d+)\.(\d+)$/;
const SHA = /^[0-9a-f]{7,64}$/;

function fail(message) {
  throw new Error(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function now() {
  return new Date().toISOString();
}

export function validateReleaseIdentity(version, sourceSha) {
  if (!VERSION.test(version ?? '')) fail(`invalid release version: ${version ?? '<missing>'}`);
  if (!SHA.test(sourceSha ?? '')) fail(`invalid release sha: ${sourceSha ?? '<missing>'}`);
  return { version, sourceSha };
}

export function nextReleaseVersion(previous) {
  if (!previous) return 'v0.0.1';
  const match = VERSION.exec(previous);
  if (!match) fail(`cannot increment invalid release version: ${previous}`);
  return `v${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

export function initializeRelease({ version, sourceSha, previous }) {
  validateReleaseIdentity(version, sourceSha);
  if (previous?.sourceSha === sourceSha) {
    if (previous.version !== version) {
      fail(`sha ${sourceSha} is already assigned to ${previous.version}, not ${version}`);
    }
    return previous;
  }
  const createdAt = now();
  return {
    schemaVersion: 1,
    version,
    sourceSha,
    state: 'building',
    createdAt,
    updatedAt: createdAt,
    ...(previous
      ? {
          supersedes: {
            version: previous.version,
            sourceSha: previous.sourceSha,
          },
        }
      : {}),
    artifacts: Object.fromEntries(
      RELEASE_COMPONENTS.map((component) => [component, { state: 'pending' }]),
    ),
    delivery: { state: 'pending' },
  };
}

function currentRelease(state) {
  if (state?.schemaVersion !== 1) fail('unsupported unified release state');
  validateReleaseIdentity(state.version, state.sourceSha);
  if (state.state === 'superseded') fail(`release ${state.version} was superseded`);
  return state;
}

function componentEntry(state, component) {
  if (!RELEASE_COMPONENTS.includes(component)) fail(`unknown release component: ${component}`);
  return state.artifacts?.[component] ?? fail(`release state has no ${component} artifact`);
}

export function markBuilt(state, component, identity = state) {
  currentRelease(state);
  const entry = componentEntry(state, component);
  validateReleaseIdentity(identity.version, identity.sourceSha);
  if (identity.version !== state.version || identity.sourceSha !== state.sourceSha) {
    fail(
      `${component} artifact identity ${identity.version}@${identity.sourceSha} does not match release ` +
        `${state.version}@${state.sourceSha}`,
    );
  }
  state.artifacts[component] = {
    ...entry,
    state: 'built',
    version: identity.version,
    sourceSha: identity.sourceSha,
    builtAt: now(),
  };
  state.updatedAt = now();
  return state;
}

export function assertAllArtifactsBuilt(state) {
  currentRelease(state);
  for (const component of RELEASE_COMPONENTS) {
    const entry = componentEntry(state, component);
    if (
      entry.state !== 'built' ||
      entry.version !== state.version ||
      entry.sourceSha !== state.sourceSha
    ) {
      fail(`${component} artifact is not built for ${state.version}@${state.sourceSha}`);
    }
  }
  state.state = 'ready';
  state.updatedAt = now();
  return state;
}

export function confirmPromotion(state, component, identity = state) {
  currentRelease(state);
  if (state.state !== 'ready' && state.state !== 'promoting') {
    fail(`release ${state.version} is not ready for promotion`);
  }
  validateReleaseIdentity(identity.version, identity.sourceSha);
  if (identity.version !== state.version || identity.sourceSha !== state.sourceSha) {
    fail(`mixed-version ${component} confirmation refused`);
  }
  const position = RELEASE_COMPONENTS.indexOf(component);
  for (const dependency of RELEASE_COMPONENTS.slice(0, position)) {
    if (componentEntry(state, dependency).state !== 'confirmed') {
      fail(`${component} cannot promote before ${dependency} confirms`);
    }
  }
  const entry = componentEntry(state, component);
  if (!['built', 'confirmed'].includes(entry.state)) {
    fail(`${component} cannot promote from ${entry.state}`);
  }
  state.artifacts[component] = {
    ...entry,
    state: 'confirmed',
    confirmedAt: now(),
  };
  state.state = 'promoting';
  state.updatedAt = now();
  return state;
}

export function confirmDelivery(state, identity = state) {
  currentRelease(state);
  if (componentEntry(state, 'app').state !== 'confirmed') {
    fail('delivery cannot confirm before app promotion');
  }
  validateReleaseIdentity(identity.version, identity.sourceSha);
  if (identity.version !== state.version || identity.sourceSha !== state.sourceSha) {
    fail('mixed-version delivery confirmation refused');
  }
  state.delivery = {
    state: 'passed',
    version: identity.version,
    sourceSha: identity.sourceSha,
    confirmedAt: now(),
  };
  state.state = 'delivered';
  state.updatedAt = now();
  return state;
}

export function supersedeRelease(state, nextIdentity) {
  currentRelease(state);
  validateReleaseIdentity(nextIdentity.version, nextIdentity.sourceSha);
  if (nextIdentity.sourceSha === state.sourceSha) fail('a release cannot supersede itself');
  state.state = 'superseded';
  state.supersededBy = { ...nextIdentity, at: now() };
  state.updatedAt = now();
  return state;
}

export function deliveryReport(state, observed = undefined) {
  currentRelease(state);
  if (observed) {
    for (const component of RELEASE_COMPONENTS) {
      const identity = observed[component];
      validateReleaseIdentity(identity?.version, identity?.sourceSha);
      if (identity.version !== state.version || identity.sourceSha !== state.sourceSha) {
        fail(
          `NOT DELIVERED: mixed-version ${component} is ${identity.version}@${identity.sourceSha}; ` +
            `expected ${state.version}@${state.sourceSha}`,
        );
      }
    }
  }
  const componentsConfirmed = RELEASE_COMPONENTS.every(
    (component) => componentEntry(state, component).state === 'confirmed',
  );
  if (!componentsConfirmed || state.delivery?.state !== 'passed' || state.state !== 'delivered') {
    fail(`NOT DELIVERED: ${state.version}@${state.sourceSha} is not aligned and ledger-confirmed`);
  }
  return `DELIVERED ${state.version} (${state.sourceSha})`;
}

export function assertDaemonFleetReady(status, version, sourceSha) {
  validateReleaseIdentity(version, sourceSha);
  const daemons = Array.isArray(status?.daemons) ? status.daemons : [];
  if (daemons.length === 0) fail('daemon readiness reported no registered agents');
  const failures = daemons.filter(
    (daemon) =>
      daemon?.state !== 'ready' ||
      daemon?.releaseVersion !== version ||
      daemon?.sourceSha !== sourceSha,
  );
  if (failures.length > 0) {
    fail(
      failures
        .map(
          (daemon) =>
            `agent ${daemon?.agentPubkey ?? '<unknown>'} reported ` +
            `${daemon?.state ?? '<missing-state>'} ` +
            `${daemon?.releaseVersion ?? '<missing-version>'}@${daemon?.sourceSha ?? '<missing-sha>'}; ` +
            `expected ready ${version}@${sourceSha}`,
        )
        .join('\n'),
    );
  }
  return daemons;
}

function options(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      parsed._.push(value);
      continue;
    }
    parsed[value.slice(2)] = argv[++index];
  }
  return parsed;
}

function identityFromOptions(args) {
  return { version: args.version, sourceSha: args.sha };
}

function main(argv) {
  const args = options(argv);
  const command = args._[0];
  if (command === 'next-version') {
    const previous = args.previous ? readJson(args.previous) : undefined;
    process.stdout.write(`${nextReleaseVersion(previous?.version)}\n`);
    return;
  }
  if (command === 'init') {
    const previous = args.previous ? readJson(args.previous) : undefined;
    writeJson(args.state, initializeRelease({ ...identityFromOptions(args), previous }));
    return;
  }
  if (command === 'assert-daemons') {
    assertDaemonFleetReady(readJson(args.status), args.version, args.sha);
    console.log(`daemon fleet READY on ${args.version}@${args.sha}`);
    return;
  }
  const state = readJson(args.state);
  switch (command) {
    case 'mark-built':
      markBuilt(state, args.component, identityFromOptions(args));
      break;
    case 'assert-built':
      assertAllArtifactsBuilt(state);
      break;
    case 'confirm':
      confirmPromotion(state, args.component, identityFromOptions(args));
      break;
    case 'confirm-delivery':
      confirmDelivery(state, identityFromOptions(args));
      break;
    case 'supersede':
      supersedeRelease(state, identityFromOptions(args));
      break;
    case 'report':
      console.log(deliveryReport(state, args.observed ? readJson(args.observed) : undefined));
      return;
    default:
      fail(
        'Usage: unified-release.mjs <next-version|init|mark-built|assert-built|assert-daemons|confirm|confirm-delivery|supersede|report>',
      );
  }
  writeJson(args.state, state);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
