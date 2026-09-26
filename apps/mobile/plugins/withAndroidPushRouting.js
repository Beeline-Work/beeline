const fs = require('node:fs');
const path = require('node:path');
const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');

const ANDROID_PUSH_CLICK_ACTION = 'app.usebeeline.NOTIFICATION';
const PUSH_ACTIVITY = '.PushNotificationActivity';
const PUSH_LIFECYCLE_PROVIDER = '.PushRoutingLifecycleProvider';
const PUSH_ACTIVITY_THEME = '@android:style/Theme.Translucent.NoTitleBar';

/**
 * The server sends every Android push with this `click_action`, so the tap
 * resolves here (same package, so the activity stays unexported) instead of to
 * FCM's default launcher intent — which Android answers by RESUMING the
 * retained task, handing a singleTask MainActivity none of the tap's extras.
 *
 * An explicit intent is delivered, but WHERE depends on what is still alive:
 *
 * - MainActivity live: `onNewIntent` carries the fresh extras straight to
 *   expo-notifications' registered listener, and the navigation stack, scroll
 *   position and composer drafts all survive. Clearing the task here would
 *   rebuild the app root on every ordinary tap.
 * - MainActivity gone while its task stayed in recents (the process was
 *   killed): Android relaunches the retained record with the intent RECORDED on
 *   it — an older notification's extras — and only queues the fresh intent for
 *   after `onResume`. expo-notifications parks the first FCM extras it sees in a
 *   single slot (`NotificationManager.onNotificationResponseFromExtras`), so the
 *   stale response takes the slot, the fresh one is dropped, and the tap lands
 *   on the deck. Clearing the task builds MainActivity from THIS intent instead.
 *
 * `PushRoutingState` is what tells those two apart: a provider registers its
 * lifecycle callbacks at process start, before any activity exists.
 */
const pushActivitySource = (packageName) => `package ${packageName}

import android.app.Activity
import android.content.Intent
import android.os.Bundle

class PushNotificationActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val destination = Intent(this, MainActivity::class.java)
    destination.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    if (!PushRoutingState.mainActivityIsLive) {
      destination.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK)
    }
    val extras = intent?.extras
    if (extras != null) destination.putExtras(extras)
    startActivity(destination)
    finish()
  }
}
`;

const pushLifecycleSource = (packageName) => `package ${packageName}

import android.app.Activity
import android.app.Application
import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.Bundle
import java.util.concurrent.atomic.AtomicInteger

object PushRoutingState {
  private val liveMainActivities = AtomicInteger(0)

  val mainActivityIsLive: Boolean
    get() = liveMainActivities.get() > 0

  fun observe(application: Application) {
    application.registerActivityLifecycleCallbacks(
      object : Application.ActivityLifecycleCallbacks {
        override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
          if (activity is MainActivity) liveMainActivities.incrementAndGet()
        }

        override fun onActivityDestroyed(activity: Activity) {
          if (activity is MainActivity) liveMainActivities.decrementAndGet()
        }

        override fun onActivityStarted(activity: Activity) = Unit

        override fun onActivityResumed(activity: Activity) = Unit

        override fun onActivityPaused(activity: Activity) = Unit

        override fun onActivityStopped(activity: Activity) = Unit

        override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
      },
    )
  }
}

class PushRoutingLifecycleProvider : ContentProvider() {
  override fun onCreate(): Boolean {
    (context?.applicationContext as? Application)?.let(PushRoutingState::observe)
    return true
  }

  override fun query(
    uri: Uri,
    projection: Array<String>?,
    selection: String?,
    selectionArgs: Array<String>?,
    sortOrder: String?,
  ): Cursor? = null

  override fun getType(uri: Uri): String? = null

  override fun insert(uri: Uri, values: ContentValues?): Uri? = null

  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<String>?): Int = 0

  override fun update(
    uri: Uri,
    values: ContentValues?,
    selection: String?,
    selectionArgs: Array<String>?,
  ): Int = 0
}
`;

const pushRoutingSources = (packageName) => ({
  'PushNotificationActivity.kt': pushActivitySource(packageName),
  'PushRoutingLifecycleProvider.kt': pushLifecycleSource(packageName),
});

function upsertComponent(components, name) {
  const existing = components.find((component) => component.$?.['android:name'] === name);
  const component = existing ?? { $: {} };
  if (!existing) components.push(component);
  return component;
}

function withPushActivityManifest(config) {
  return withAndroidManifest(config, (manifestConfig) => {
    const packageName = manifestConfig.android?.package;
    if (!packageName) throw new Error('Android package is required for push routing');
    const application = manifestConfig.modResults.manifest.application?.[0];
    if (!application) throw new Error('Android manifest is missing its application');
    application.activity ??= [];
    application.provider ??= [];

    const pushActivity = upsertComponent(application.activity, PUSH_ACTIVITY);
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

    const lifecycleProvider = upsertComponent(application.provider, PUSH_LIFECYCLE_PROVIDER);
    lifecycleProvider.$ = {
      ...lifecycleProvider.$,
      'android:name': PUSH_LIFECYCLE_PROVIDER,
      'android:authorities': `${packageName}.pushrouting`,
      'android:exported': 'false',
    };

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
      for (const [fileName, contents] of Object.entries(pushRoutingSources(packageName))) {
        fs.writeFileSync(path.join(sourceDir, fileName), contents);
      }
      return modConfig;
    },
  ]);
}

function withAndroidPushRouting(config) {
  return withPushActivitySource(withPushActivityManifest(config));
}

module.exports = withAndroidPushRouting;
