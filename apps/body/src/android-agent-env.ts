import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';

/**
 * Android SDK wiring for an agent whose `$HOME` is its isolated agent home
 * (`agent-home.ts`). The SDK, AVDs and emulator data stay in the operator's
 * home, so the agent is pointed at them explicitly and gets `adb` and
 * `emulator` on PATH. `/dev/kvm` is bound into the sandbox separately
 * (`bwrap-sandbox.ts`).
 *
 * Agents share the host network, so by default every agent's adb client talks
 * to one server on tcp:5037, which also scans console ports 5554-5585 for
 * emulators: one agent's `adb shell` could land on another agent's emulator.
 * Each agent home instead gets its own adb server port, `ADB_EMU=0` so that
 * server never scans for emulators, and an emulator console port above that
 * scan range. An emulator started with `-port BEELINE_ANDROID_EMULATOR_PORT`
 * registers only with the agent's own server (it reads
 * `ANDROID_ADB_SERVER_PORT`) and stays invisible to tcp:5037. Being a real
 * emulator transport, `adb reverse` keeps working on it.
 *
 * Ports come from a hash of the agent home, so two agent homes can share a
 * slot (1 in ANDROID_PORT_SLOTS per pair); they then share one adb server.
 */
export const ANDROID_FIRST_EMULATOR_PORT = 5600;
export const ANDROID_PORT_SLOTS = 100;

export function androidAgentEnv(input: {
  root: string;
  operatorHome: string;
  inheritedPath?: string;
  env?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const env = input.env ?? process.env;
  const sdk = [
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    resolve(input.operatorHome, 'android-sdk'),
    resolve(input.operatorHome, 'Android/Sdk'),
  ].find((path) => path && existsSync(resolve(path, 'platform-tools/adb')));
  if (!sdk) return {};
  const emulatorHome = env.ANDROID_EMULATOR_HOME ?? resolve(input.operatorHome, '.android');
  const slot =
    createHash('sha256').update(resolve(input.root)).digest().readUInt32BE(0) % ANDROID_PORT_SLOTS;
  // The emulator takes its console port and the next one; the adb server
  // takes the port after those.
  const emulatorPort = ANDROID_FIRST_EMULATOR_PORT + slot * 4;
  return {
    ANDROID_HOME: sdk,
    ANDROID_SDK_ROOT: sdk,
    ANDROID_EMULATOR_HOME: emulatorHome,
    ANDROID_AVD_HOME: env.ANDROID_AVD_HOME ?? resolve(emulatorHome, 'avd'),
    ANDROID_ADB_SERVER_PORT: String(emulatorPort + 2),
    ADB_EMU: '0',
    BEELINE_ANDROID_EMULATOR_PORT: String(emulatorPort),
    PATH: [
      resolve(sdk, 'platform-tools'),
      resolve(sdk, 'emulator'),
      input.inheritedPath ?? env.PATH,
    ]
      .filter(Boolean)
      .join(delimiter),
  };
}
