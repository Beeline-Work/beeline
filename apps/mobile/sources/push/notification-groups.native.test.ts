import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const withRoomNotificationGroups = require('../../plugins/withRoomNotificationGroups');

describe('Room notification native registration', () => {
  it('replaces both Expo entry points once, including after repeated prebuilds', async () => {
    const config = withRoomNotificationGroups({ name: 'proof', slug: 'proof' });
    expect(Object.keys(config.mods)).toEqual(['android']);
    let mod = {
      modResults: { manifest: { $: {}, application: [{}] } },
      modRequest: {},
      modRawConfig: config,
    };
    mod = await config.mods.android.manifest(mod);
    mod = await config.mods.android.manifest(mod);
    const app = mod.modResults.manifest.application[0] as Record<
      string,
      Array<{ $: Record<string, string> }>
    >;
    for (const [kind, replacement] of [
      ['service', 'RoomFirebaseMessagingService'],
      ['receiver', 'RoomNotificationsService'],
    ]) {
      expect(app[kind]).toHaveLength(2);
      expect(app[kind][0].$['tools:node']).toBe('remove');
      expect(app[kind][1].$).toEqual({
        'android:name': `app.usebeeline.push.${replacement}`,
        'android:exported': 'false',
      });
    }
  });

  it('adds Firebase to the app compile classpath without duplicating the dependency', async () => {
    const config = withRoomNotificationGroups({ name: 'proof', slug: 'proof' });
    let mod = { modResults: { contents: 'dependencies {}' }, modRequest: {}, modRawConfig: config };
    mod = await config.mods.android.appBuildGradle(mod);
    mod = await config.mods.android.appBuildGradle(mod);
    expect(mod.modResults.contents.match(/com.google.firebase:firebase-messaging:/g)).toHaveLength(
      1,
    );
  });
});
