const fs = require('node:fs');
const path = require('node:path');

module.exports = function withLatencyRigNativeProbe(config) {
  const url = new URL(process.env.EXPO_PUBLIC_BUZZY_MONOLITH_URL || 'https://invalid');
  if (url.hostname !== '10.0.2.2' || !['http:', 'https:'].includes(url.protocol) || !url.port)
    throw new Error('Native latency probe requires the disposable emulator host proxy');
  const { withDangerousMod } = require('@expo/config-plugins');
  return withDangerousMod(config, ['android', async (mod) => {
    const dir = path.join(mod.modRequest.platformProjectRoot, 'app/src/main');
    const java = path.join(dir, 'java/app/usebeeline');
    const templates = path.resolve(mod.modRequest.projectRoot, '../../scripts/latency-rig/android');
    for (const name of ['LatencyRigProbe', 'LatencyRigReceiver'])
      fs.copyFileSync(path.join(templates, `${name}.java`), path.join(java, `${name}.java`));
    const edit = (file, needle, replacement) => {
      const source = fs.readFileSync(file, 'utf8');
      if (!source.includes(needle)) throw new Error(`Native rig hook missing in ${path.basename(file)}`);
      fs.writeFileSync(file, source.replace(needle, replacement));
    };
    edit(path.join(java, 'MainActivity.kt'), 'super.onCreate(null)', 'super.onCreate(null)\n    LatencyRigProbe.attach(this)');
    edit(path.join(java, 'MainActivity.kt'), 'class MainActivity : ReactActivity() {', `class MainActivity : ReactActivity() {
  override fun dispatchTouchEvent(event: android.view.MotionEvent): Boolean {
    if (event.actionMasked == android.view.MotionEvent.ACTION_UP) {
      LatencyRigProbe.begin("room-list")
      LatencyRigProbe.begin("send-text")
    }
    return super.dispatchTouchEvent(event)
  }`);
    edit(path.join(java, 'PushNotificationActivity.kt'), 'super.onCreate(savedInstanceState)', 'super.onCreate(savedInstanceState)\n    LatencyRigProbe.begin("push")');
    edit(path.join(dir, 'AndroidManifest.xml'), '</application>', `<receiver android:name=".LatencyRigReceiver" android:exported="true" android:permission="android.permission.DUMP" /></application>`);
    return mod;
  }]);
};
