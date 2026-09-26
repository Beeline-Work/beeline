const fs = require('node:fs');
const path = require('node:path');
const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');

const ANDROID_PUSH_CLICK_ACTION = 'app.usebeeline.NOTIFICATION';
const PUSH_ACTIVITY = '.PushNotificationActivity';
const PUSH_ACTIVITY_THEME = '@android:style/Theme.Translucent.NoTitleBar';

/**
 * The server sends every Android push with this `click_action`, so the tap
 * resolves here (same package, so the activity stays unexported) instead of to
 * FCM's default launcher intent — which Android answers by RESUMING the
 * retained task, handing a singleTask MainActivity none of the tap's extras.
 *
 * Forwarding clears that task so MainActivity is always built from THIS intent.
 * Android otherwise relaunches a retained record with the intent RECORDED on it
 * — an older notification's extras — and expo-notifications parks the first FCM
 * extras it sees in a single slot
 * (`NotificationManager.onNotificationResponseFromExtras`), so the stale
 * response takes the slot, the fresh one is dropped, and the tap lands on the
 * deck.
 */
const pushActivitySource = (packageName) => `package ${packageName}

import android.app.Activity
import android.content.Intent
import android.os.Bundle

class PushNotificationActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val destination = Intent(this, MainActivity::class.java)
    destination.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
    val extras = intent?.extras
    if (extras != null) destination.putExtras(extras)
    startActivity(destination)
    finish()
  }
}
`;

function withPushActivityManifest(config) {
  return withAndroidManifest(config, (manifestConfig) => {
    const application = manifestConfig.modResults.manifest.application?.[0];
    if (!application) throw new Error('Android manifest is missing its application');
    application.activity ??= [];
    const existing = application.activity.find(
      (activity) => activity.$?.['android:name'] === PUSH_ACTIVITY,
    );
    const pushActivity = existing ?? { $: {} };
    pushActivity.$ = {
      ...pushActivity.$,
      'android:name': PUSH_ACTIVITY,
      'android:exported': 'false',
      'android:excludeFromRecents': 'true',
      'android:noHistory': 'true',
      'android:taskAffinity': '',
      'android:theme': PUSH_ACTIVITY_THEME,
    };
    pushActivity['intent-filter'] = [
      {
        action: [{ $: { 'android:name': ANDROID_PUSH_CLICK_ACTION } }],
        category: [{ $: { 'android:name': 'android.intent.category.DEFAULT' } }],
      },
    ];
    if (!existing) application.activity.push(pushActivity);
    return manifestConfig;
  });
}

function withPushActivitySource(config) {
  return withDangerousMod(config, [
    'android',
    async (modConfig) => {
      const packageName = modConfig.android?.package;
      if (!packageName) throw new Error('Android package is required for push routing');
      const sourceDir = path.join(
        modConfig.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'java',
        ...packageName.split('.'),
      );
      fs.mkdirSync(sourceDir, { recursive: true });
      fs.writeFileSync(
        path.join(sourceDir, 'PushNotificationActivity.kt'),
        pushActivitySource(packageName),
      );
      return modConfig;
    },
  ]);
}

function withAndroidPushRouting(config) {
  return withPushActivitySource(withPushActivityManifest(config));
}

module.exports = withAndroidPushRouting;
