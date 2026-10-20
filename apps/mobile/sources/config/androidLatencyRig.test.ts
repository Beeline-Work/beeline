import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const plugin = require('../../plugins/withLatencyRigNativeProbe.js');

it('keeps one native hook and one protected receiver after repeated prebuild', async () => {
  const root = mkdtempSync(join(tmpdir(), 'beeline-native-rig-'));
  const previous = process.env.EXPO_PUBLIC_BUZZY_MONOLITH_URL;
  try {
    process.env.EXPO_PUBLIC_BUZZY_MONOLITH_URL = 'http://10.0.2.2:18881';
    const projectRoot = join(root, 'apps/mobile');
    const platformProjectRoot = join(projectRoot, 'android');
    const main = join(platformProjectRoot, 'app/src/main');
    const java = join(main, 'java/app/usebeeline');
    const templates = join(root, 'scripts/latency-rig/android');
    mkdirSync(java, { recursive: true });
    mkdirSync(templates, { recursive: true });
    for (const name of ['LatencyRigProbe', 'LatencyRigReceiver']) {
      copyFileSync(fileURLToPath(new URL(`../../../../scripts/latency-rig/android/${name}.java`, import.meta.url)),
        join(templates, `${name}.java`));
    }
    writeFileSync(join(java, 'MainActivity.kt'), 'class MainActivity : ReactActivity() {\n fun onCreate() { super.onCreate(null) }\n}');
    writeFileSync(join(java, 'PushNotificationActivity.kt'), 'class PushNotificationActivity {\n fun onCreate() { super.onCreate(savedInstanceState) }\n}');
    const manifest = join(main, 'AndroidManifest.xml');
    writeFileSync(manifest, '<manifest><application></application></manifest>');
    const run = () => plugin({}).mods.android.dangerous({
      modRequest: { projectRoot, platformProjectRoot },
    });
    await run();
    // Expo may reformat the manifest before the dangerous mod runs again.
    writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('</application>', '\n </application>'));
    await run();
    const activity = readFileSync(join(java, 'MainActivity.kt'), 'utf8');
    expect(activity.match(/override fun dispatchTouchEvent/g)).toHaveLength(1);
    expect(activity.match(/LatencyRigProbe.attach/g)).toHaveLength(1);
    expect(readFileSync(join(java, 'PushNotificationActivity.kt'), 'utf8').match(/LatencyRigProbe.begin/g)).toHaveLength(1);
    const xml = readFileSync(manifest, 'utf8');
    expect(xml.match(/android:name=".LatencyRigReceiver"/g)).toHaveLength(1);
    expect(xml).toContain('android:permission="android.permission.DUMP"');
  } finally {
    if (previous === undefined) delete process.env.EXPO_PUBLIC_BUZZY_MONOLITH_URL;
    else process.env.EXPO_PUBLIC_BUZZY_MONOLITH_URL = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
