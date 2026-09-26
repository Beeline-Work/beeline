import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
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
  manifest: {
    application?: { activity?: ManifestActivity[]; provider?: ManifestElement[] }[];
  };
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

const PUSH_ACTIVITY = '.PushNotificationActivity';
const PUSH_PROVIDER = '.PushRoutingLifecycleProvider';

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

function providers(manifest: AndroidManifest): ManifestElement[] {
  return manifest.manifest.application?.[0]?.provider ?? [];
}

function activity(manifest: AndroidManifest, name: string): ManifestActivity {
  const found = activities(manifest).filter((entry) => entry.$?.['android:name'] === name);
  expect(found).toHaveLength(1);
  return found[0];
}

async function generatedSources(packageName: string): Promise<Record<string, string>> {
  const { plugin } = await applyPlugin(packageName);
  const projectRoot = mkdtempSync(join(tmpdir(), 'beeline-push-source-'));
  await plugin.mods.android.dangerous({
    ...plugin,
    modRequest: { platformProjectRoot: join(projectRoot, 'android') },
  });
  const sourceDir = join(projectRoot, 'android/app/src/main/java', ...packageName.split('.'));
  return Object.fromEntries(
    readdirSync(sourceDir).map((file) => [file, readFileSync(join(sourceDir, file), 'utf8')]),
  );
}

/**
 * Every flag the forwarded intent sets, and the state each one applies in — the
 * whole routing decision the generated activity encodes.
 */
function forwardedIntentFlags(activitySource: string): {
  always: string[];
  whenColdPush: string[];
} {
  const model = { always: [] as string[], whenColdPush: [] as string[] };
  let state: keyof typeof model = 'always';
  for (const line of activitySource.split('\n').map((entry) => entry.trim())) {
    if (line.includes('intent?.hasExtra("google.message_id")') && line.includes('!PushRoutingState.mainActivityIsLive')) {
      state = 'whenColdPush';
      continue;
    }
    if (line === '}') {
      state = 'always';
      continue;
    }
    const flag = line.match(/^destination\.addFlags\(Intent\.(FLAG_ACTIVITY_[A-Z_]+)\)$/);
    if (flag) model[state].push(flag[1]);
  }
  return model;
}

describe('Android push routing manifest', () => {
  it('makes the trampoline the sole launcher, so default FCM taps reach it', async () => {
    const push = activity(await generatedManifest(), PUSH_ACTIVITY);

    expect(push.$?.['android:exported']).toBe('true');
    expect(push.$?.['android:excludeFromRecents']).toBe('true');
    expect(push.$?.['android:noHistory']).toBe('true');
    // It paints nothing: a themed starting window would flash a second splash
    // over the task it is about to bring forward.
    expect(push.$?.['android:theme']).toBe('@android:style/Theme.Translucent.NoTitleBar');
    expect(push['intent-filter']).toEqual([
      {
        action: [{ $: { 'android:name': 'android.intent.action.MAIN' } }],
        category: [{ $: { 'android:name': 'android.intent.category.LAUNCHER' } }],
      },
    ]);
  });

  it('declares the lifecycle provider that runs before any activity, per package', async () => {
    for (const packageName of ['app.usebeeline', 'com.example.beeline']) {
      expect(providers(await generatedManifest(packageName))).toEqual([
        {
          $: {
            'android:name': PUSH_PROVIDER,
            'android:authorities': `${packageName}.pushrouting`,
            'android:exported': 'false',
          },
        },
      ]);
    }
  });

  it('keeps MainActivity singleTask but removes its launcher filter', async () => {
    const manifest = await generatedManifest();
    const main = activity(manifest, '.MainActivity');
    expect(main.$?.['android:launchMode']).toBe('singleTask');
    expect(main['intent-filter'] ?? []).toEqual([]);
    expect(activities(manifest)).toHaveLength(2);
  });

  it('declares one trampoline and one provider however many times prebuild runs the mod', async () => {
    const once = await applyPlugin('app.usebeeline');
    const twice = await applyPlugin('app.usebeeline', once.manifest);

    expect(activities(twice.manifest).map((entry) => entry.$?.['android:name'])).toEqual([
      '.MainActivity',
      PUSH_ACTIVITY,
    ]);
    expect(providers(twice.manifest).map((entry) => entry.$?.['android:name'])).toEqual([
      PUSH_PROVIDER,
    ]);
  });
});

describe('Android push routing generated sources', () => {
  it('writes a class for every component it declares, in the configured package', async () => {
    for (const packageName of ['app.usebeeline', 'com.example.beeline']) {
      const sources = await generatedSources(packageName);
      const manifest = await generatedManifest(packageName);
      const declared = [...activities(manifest), ...providers(manifest)]
        .map((entry) => entry.$?.['android:name'])
        .filter((name): name is string => !!name && name !== '.MainActivity')
        .map((name) => name.slice(1));

      expect(declared).toEqual(['PushNotificationActivity', 'PushRoutingLifecycleProvider']);
      for (const className of declared) {
        const contents = sources[`${className}.kt`];
        expect(contents?.split('\n')[0]).toBe(`package ${packageName}`);
        expect(contents).toMatch(new RegExp(`(class|object) ${className}\\b`));
      }
    }
  });

  it('clears the task only when no live MainActivity can take the fresh intent', async () => {
    const sources = await generatedSources('app.usebeeline');

    // A live MainActivity takes the extras through onNewIntent and keeps its
    // navigation stack. A killed process leaves a retained record Android
    // relaunches with an OLDER notification's intent, which takes
    // expo-notifications' single pending-response slot and drops this tap —
    // clearing the task is what builds MainActivity from THIS intent instead.
    expect(forwardedIntentFlags(sources['PushNotificationActivity.kt'])).toEqual({
      always: ['FLAG_ACTIVITY_NEW_TASK'],
      whenColdPush: ['FLAG_ACTIVITY_CLEAR_TASK'],
    });
    expect(sources['PushNotificationActivity.kt']).toContain(
      'Intent(this, MainActivity::class.java)',
    );
    expect(sources['PushNotificationActivity.kt']).toContain('putExtras(extras)');
  });
});
