#!/usr/bin/env node

const { spawnSync } = require("child_process");

const workspaceRoot = __dirname;

const actions = [
  {
    id: "all",
    label: "Store build",
    description: "Build and submit the single production app",
    scripts: ["release:build:appstore"],
  },
  {
    id: "all-interactive",
    label: "All interactive",
    description: "Build and submit the single production app with interactive prompts",
    scripts: ["release:build:appstore:interactive"],
  },
  {
    id: "appstore-build",
    label: "App Store build",
    description: "Run production store builds and auto-submit",
    scripts: ["release:build:appstore"],
  },
  {
    id: "ota-beta",
    label: "OTA candidate (beta)",
    description: "Publish an update candidate to beta; production promotion stays in the release governor",
    scripts: ["release:ota:release"],
  },
];

const actionAliases = {
  all: "all",
  interactive: "all-interactive",
  "all-interactive": "all-interactive",
  "all interactive": "all-interactive",
  appstore: "appstore-build",
  store: "appstore-build",
  "appstore-build": "appstore-build",
  "ota-beta": "ota-beta",
  "ota:beta": "ota-beta",
  beta: "ota-beta",
};

function findAction(input) {
  const normalized = String(input || "").trim().toLowerCase();
  const actionId = actionAliases[normalized] || normalized;
  return actions.find((action) => action.id === actionId);
}

function printAvailableOptions() {
  console.error("Available happy-app release options:");
  for (const action of actions) {
    console.error(`- ${action.id}: ${action.description}`);
  }
}

function runScript(scriptName) {
  console.log(`> pnpm run ${scriptName}`);
  const result = spawnSync("pnpm", ["run", scriptName], {
    cwd: workspaceRoot,
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function promptForAction() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("Interactive happy-app release selection requires a TTY.");
    printAvailableOptions();
    console.error("Run `pnpm release -- <option>` in non-interactive mode.");
    process.exit(1);
  }

  let select;
  try {
    ({ select } = await import("@inquirer/prompts"));
  } catch (error) {
    console.error("Missing interactive prompt dependency: `@inquirer/prompts`.");
    console.error(
      "Run `pnpm install` from repository root, then run `pnpm --filter happy-app release` again."
    );
    process.exit(1);
  }

  const actionId = await select({
    message: "What should be released for happy-app?",
    pageSize: 10,
    choices: actions.map((action) => ({
      name: action.label,
      value: action.id,
      description: action.description,
    })),
  });

  return findAction(actionId);
}

async function main() {
  const input = process.argv[2];
  if (input === "--help" || input === "-h") {
    console.log("Usage: pnpm release -- <option>");
    printAvailableOptions();
    return;
  }

  let action = input ? findAction(input) : null;
  if (input && !action) {
    console.error(`Unknown happy-app release option: ${input}`);
    printAvailableOptions();
    process.exit(1);
  }

  if (!action) {
    action = await promptForAction();
  }

  console.log(`Running happy-app release option: ${action.label}`);
  for (const scriptName of action.scripts) {
    runScript(scriptName);
  }
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
