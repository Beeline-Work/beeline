const fs = require('node:fs');
const path = require('node:path');
const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');

const ANDROID_PUSH_CLICK_ACTION = 'app.usebeeline.NOTIFICATION';
const PUSH_ACTIVITY = '.PushNotificationActivity';

const PUSH_ACTIVITY_SOURCE = `package app.usebeeline

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/**
 * Gives each FCM tap a fresh task intent. MainActivity is singleTask, so Android can otherwise
 * resurrect a retained task with an older notification's extras after the process was killed.
 */
class PushNotificationActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val sourceExtras = intent?.extras
    val destination = Intent(this, MainActivity::class.java).apply {
      action = Intent.ACTION_MAIN
      addCategory(Intent.CATEGORY_LAUNCHER)
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
      if (sourceExtras != null) putExtras(sourceExtras)
    }
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
      'android:exported': 'true',
      'android:excludeFromRecents': 'true',
      'android:noHistory': 'true',
      'android:theme': '@style/Theme.App.SplashScreen',
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
      fs.writeFileSync(path.join(sourceDir, 'PushNotificationActivity.kt'), PUSH_ACTIVITY_SOURCE);
      return modConfig;
    },
  ]);
}

function withAndroidPushRouting(config) {
  return withPushActivitySource(withPushActivityManifest(config));
}

module.exports = withAndroidPushRouting;
module.exports.ANDROID_PUSH_CLICK_ACTION = ANDROID_PUSH_CLICK_ACTION;
module.exports.PUSH_ACTIVITY_SOURCE = PUSH_ACTIVITY_SOURCE;
