const {
  withAndroidManifest,
  withDangerousMod,
  withAppBuildGradle,
} = require('@expo/config-plugins');
const fs = require('node:fs');
const path = require('node:path');

module.exports = function withRoomNotificationGroups(config) {
  config = withAppBuildGradle(config, (mod) => {
    // Expo keeps this dependency implementation-private; our subclass needs it
    // on the app compile classpath too. Match expo-notifications 55's version.
    const dependency = "implementation 'com.google.firebase:firebase-messaging:25.0.1'";
    if (!mod.modResults.contents.includes(dependency)) {
      mod.modResults.contents += `\ndependencies { ${dependency} }\n`;
    }
    return mod;
  });
  config = withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest;
    manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
    const app = manifest.application[0];
    for (const [kind, original, replacement, actions] of [
      [
        'service',
        'ExpoFirebaseMessagingService',
        'RoomFirebaseMessagingService',
        ['com.google.firebase.MESSAGING_EVENT'],
      ],
      [
        'receiver',
        'NotificationsService',
        'RoomNotificationsService',
        [
          'expo.modules.notifications.NOTIFICATION_EVENT',
          'android.intent.action.BOOT_COMPLETED',
          'android.intent.action.REBOOT',
          'android.intent.action.QUICKBOOT_POWERON',
          'com.htc.intent.action.QUICKBOOT_POWERON',
          'android.intent.action.MY_PACKAGE_REPLACED',
        ],
      ],
    ]) {
      app[kind] ??= [];
      const oldName = `expo.modules.notifications.service.${original}`;
      const newName = `app.usebeeline.push.${replacement}`;
      app[kind] = app[kind].filter(
        (entry) => ![oldName, newName].includes(entry.$['android:name']),
      );
      app[kind].push({ $: { 'android:name': oldName, 'tools:node': 'remove' } });
      app[kind].push({
        $: { 'android:name': newName, 'android:exported': 'false' },
        'intent-filter': [
          {
            $: { 'android:priority': '1' },
            action: actions.map((name) => ({ $: { 'android:name': name } })),
          },
        ],
      });
    }
    return mod;
  });
  return withDangerousMod(config, [
    'android',
    async (mod) => {
      const dest = path.join(
        mod.modRequest.platformProjectRoot,
        'app/src/main/java/app/usebeeline/push',
      );
      fs.mkdirSync(dest, { recursive: true });
      for (const file of ['RoomFirebaseMessagingService.kt', 'RoomNotificationsService.kt']) {
        fs.copyFileSync(path.join(__dirname, 'room-notifications', file), path.join(dest, file));
      }
      return mod;
    },
  ]);
};
