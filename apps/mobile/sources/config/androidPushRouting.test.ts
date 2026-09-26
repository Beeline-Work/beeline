import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

type ManifestElement = { $?: Record<string, string> };
type ManifestActivity = ManifestElement & {
  'intent-filter'?: { action?: ManifestElement[]; category?: ManifestElement[] }[];
};
type AndroidManifest = {
  manifest: { application?: { activity?: ManifestActivity[] }[] };
};
type PushRoutingPlugin = (config: { android: { package: string } }) => {
  android: { package: string };
  mods: {
    android: {
      manifest: (props: unknown) => Promise<{ modResults: AndroidManifest }>;
      dangerous: (props: unknown) => Promise<unknown>;
    };
  };
};

const withAndroidPushRouting = require('../../plugins/withAndroidPushRouting.js') as PushRoutingPlugin;
const { AndroidConfig, XML } = require('@expo/config-plugins');

// The server serializes this exact `click_action` onto every Android push
// (`apps/server/src/firebase-push.ts`); the tap only resolves to the activity
// below while both sides spell it the same way.
const CLICK_ACTION = 'app.usebeeline.NOTIFICATION';
const PUSH_ACTIVITY = '.PushNotificationActivity';

// What `expo prebuild` hands the manifest mod: MainActivity is singleTask, so a
// live task is reused rather than rebuilt.
const prebuiltManifest = (): AndroidManifest => ({
  manifest: {
    application: [
      {
        $: { 'android:name': '.MainApplication' },
        activity: [
          {
            $: {
              'android:name': '.MainActivity',
              'android:launchMode': 'singleTask',
              'android:exported': 'true',
            },
            'intent-filter': [
              {
                action: [{ $: { 'android:name': 'android.intent.action.MAIN' } }],
                category: [{ $: { 'android:name': 'android.intent.category.LAUNCHER' } }],
              },
            ],
          },
        ],
      },
    ],
  },
});

async function applyPlugin(packageName: string, manifest = prebuiltManifest()) {
  const plugin = withAndroidPushRouting({ android: { package: packageName } });
  const applied = await plugin.mods.android.manifest({
    ...plugin,
    modResults: manifest,
    modRequest: {},
  });
  return { plugin, manifest: applied.modResults };
}

// The manifest the plugin produces, read back through the same XML writer and
// reader Expo prebuild uses, so what is asserted is the declaration Android
// would actually receive.
async function generatedManifest(packageName = 'app.usebeeline'): Promise<AndroidManifest> {
  const { manifest } = await applyPlugin(packageName);
  const file = join(mkdtempSync(join(tmpdir(), 'beeline-push-manifest-')), 'AndroidManifest.xml');
  await XML.writeXMLAsync({ path: file, xml: manifest });
  return AndroidConfig.Manifest.readAndroidManifestAsync(file);
}

function activities(manifest: AndroidManifest): ManifestActivity[] {
  return manifest.manifest.application?.[0]?.activity ?? [];
}

function activity(manifest: AndroidManifest, name: string): ManifestActivity {
  const found = activities(manifest).filter((entry) => entry.$?.['android:name'] === name);
  expect(found).toHaveLength(1);
  return found[0];
}

async function generatedSource(packageName: string): Promise<string> {
  const { plugin } = await applyPlugin(packageName);
  const projectRoot = mkdtempSync(join(tmpdir(), 'beeline-push-source-'));
  await plugin.mods.android.dangerous({
    ...plugin,
    modRequest: { platformProjectRoot: join(projectRoot, 'android') },
  });
  const file = join(
    projectRoot,
    'android/app/src/main/java',
    ...packageName.split('.'),
    'PushNotificationActivity.kt',
  );
  expect(existsSync(file)).toBe(true);
  return readFileSync(file, 'utf8');
}

describe('Android push routing manifest', () => {
  it('declares the tap trampoline for the app itself, reachable by no other app', async () => {
    const push = activity(await generatedManifest(), PUSH_ACTIVITY);

    // The FCM content PendingIntent is created and sent under this app's own
    // identity, so the implicit same-package start still resolves. Exported,
    // any installed app could fabricate a tap for an arbitrary Room id.
    expect(push.$?.['android:exported']).toBe('false');
    expect(push.$?.['android:excludeFromRecents']).toBe('true');
    expect(push.$?.['android:noHistory']).toBe('true');
    // Its own task, so forwarding never disturbs the app's task.
    expect(push.$?.['android:taskAffinity']).toBe('');
    // It paints nothing: a themed starting window would flash a second splash
    // over the task it is about to bring forward.
    expect(push.$?.['android:theme']).toBe('@android:style/Theme.Translucent.NoTitleBar');
    expect(push['intent-filter']).toEqual([
      {
        action: [{ $: { 'android:name': CLICK_ACTION } }],
        category: [{ $: { 'android:name': 'android.intent.category.DEFAULT' } }],
      },
    ]);
  });

  it('leaves MainActivity as the launcher singleTask instance it found', async () => {
    const manifest = await generatedManifest();

    expect(activity(manifest, '.MainActivity')).toEqual(
      activity(prebuiltManifest(), '.MainActivity'),
    );
    expect(activities(manifest)).toHaveLength(2);
  });

  it('declares one trampoline however many times prebuild runs the mod', async () => {
    const once = await applyPlugin('app.usebeeline');
    const twice = await applyPlugin('app.usebeeline', once.manifest);

    expect(activities(twice.manifest).map((entry) => entry.$?.['android:name'])).toEqual([
      '.MainActivity',
      PUSH_ACTIVITY,
    ]);
  });
});

describe('Android push routing generated source', () => {
  it('writes the activity the manifest declares, in the configured package', async () => {
    for (const packageName of ['app.usebeeline', 'com.example.beeline']) {
      const source = await generatedSource(packageName);
      const declared = activities(await generatedManifest(packageName))
        .map((entry) => entry.$?.['android:name'])
        .filter((name) => name !== '.MainActivity');

      expect(declared).toEqual([PUSH_ACTIVITY]);
      expect(source.split('\n')[0]).toBe(`package ${packageName}`);
      expect(source).toMatch(/class PushNotificationActivity\b/);
    }
  });
});
