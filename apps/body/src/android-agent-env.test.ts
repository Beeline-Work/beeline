import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ANDROID_FIRST_EMULATOR_PORT,
  ANDROID_PORT_SLOTS,
  androidAgentEnv,
} from './android-agent-env.js';

function operatorHomeWithSdk(): string {
  const home = mkdtempSync(join(tmpdir(), 'android-env-'));
  mkdirSync(join(home, 'android-sdk/platform-tools'), { recursive: true });
  writeFileSync(join(home, 'android-sdk/platform-tools/adb'), '');
  return home;
}

describe('androidAgentEnv', () => {
  it('adds nothing on a host without an Android SDK', () => {
    const home = mkdtempSync(join(tmpdir(), 'android-env-'));
    expect(androidAgentEnv({ root: join(home, 'a'), operatorHome: home, env: {} })).toEqual({});
  });

  it("points the agent at the operator's SDK and AVDs and puts adb and emulator on PATH", () => {
    const home = operatorHomeWithSdk();
    const env = androidAgentEnv({
      root: join(home, 'agent-a'),
      operatorHome: home,
      inheritedPath: '/usr/bin',
      env: {},
    });
    expect(env).toMatchObject({
      ANDROID_HOME: join(home, 'android-sdk'),
      ANDROID_SDK_ROOT: join(home, 'android-sdk'),
      ANDROID_EMULATOR_HOME: join(home, '.android'),
      ANDROID_AVD_HOME: join(home, '.android/avd'),
      ADB_EMU: '0',
      PATH: [
        join(home, 'android-sdk/platform-tools'),
        join(home, 'android-sdk/emulator'),
        '/usr/bin',
      ].join(delimiter),
    });
  });

  it('gives each agent home stable adb and emulator ports outside the 5554-5585 scan', () => {
    const home = operatorHomeWithSdk();
    // Hash slots can collide; random temporary homes cannot guarantee unique ports.
    for (const agent of ['agent-a', 'agent-b', 'agent-c']) {
      const env = androidAgentEnv({ root: join(home, agent), operatorHome: home, env: {} });
      const emulatorPort = Number(env.BEELINE_ANDROID_EMULATOR_PORT);
      expect(emulatorPort % 2).toBe(0);
      expect(emulatorPort).toBeGreaterThanOrEqual(ANDROID_FIRST_EMULATOR_PORT);
      expect(emulatorPort).toBeLessThan(ANDROID_FIRST_EMULATOR_PORT + ANDROID_PORT_SLOTS * 4);
      expect(Number(env.ANDROID_ADB_SERVER_PORT)).toBe(emulatorPort + 2);
      expect(androidAgentEnv({ root: join(home, agent), operatorHome: home, env: {} })).toEqual(
        env,
      );
    }
  });

  it("prefers the daemon's own ANDROID_HOME", () => {
    const home = operatorHomeWithSdk();
    const env = androidAgentEnv({
      root: join(home, 'agent-a'),
      operatorHome: '/nonexistent',
      env: { ANDROID_HOME: join(home, 'android-sdk') },
    });
    expect(env.ANDROID_HOME).toBe(join(home, 'android-sdk'));
  });
});
