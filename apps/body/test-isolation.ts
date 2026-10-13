import { mkdtempSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { isolatedNativeProof } from './src/lifecycle-test-guard.js';

// Every test and every child it launches inherits private paths and an unreachable
// user bus. Native acceptance runs only in the separately supervised proof container.
if (!isolatedNativeProof(process.env)) {
  // /tmp disappears inside the Room's namespace; a long worktree path exceeds
  // Unix socket limits. /var/tmp gives tests a short, private, visible home.
  const home = mkdtempSync('/var/tmp/beeline-test-');
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = resolve(home, '.config');
  process.env.XDG_STATE_HOME = resolve(home, '.local/state');
  process.env.XDG_RUNTIME_DIR = resolve(home, 'run');
  for (const path of [
    process.env.XDG_CONFIG_HOME,
    process.env.XDG_STATE_HOME,
    process.env.XDG_RUNTIME_DIR,
  ])
    mkdirSync(path, { recursive: true });
  process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${home}/run/no-user-bus`;
  process.env.BEELINE_LIB_DIR = '';
  process.env.BEELINE_INSTALL_DIR = '';
  process.env.BEELINE_INSTALL_LIB_DIR = '';
}
