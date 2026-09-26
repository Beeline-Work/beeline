const fs = require('node:fs');
const path = require('node:path');
const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');

const PUSH_ACTIVITY = '.PushNotificationActivity';
const PUSH_LIFECYCLE_PROVIDER = '.PushRoutingLifecycleProvider';
const PUSH_ACTIVITY_THEME = '@android:style/Theme.Translucent.NoTitleBar';

/**
 * FCM's default notification intent targets the package launcher. MainActivity
 * cannot be that launcher: Android can resurrect its retained task from an old
 * root intent and lose the fresh tap extras before onNewIntent runs. This
 * short-lived launcher receives both normal opens and notification taps.
 *
 * An explicit intent is delivered, but WHERE depends on what is still alive:
 *
 * - MainActivity live: `onNewIntent` carries the fresh extras straight to
 *   expo-notifications' registered listener, and the navigation stack, scroll
 *   position and composer drafts all survive. Clearing the task here would
 *   rebuild the app root on every ordinary tap.
 * - MainActivity gone while its task stayed in recents: clear that retained
 *   task only for an actual push tap, then build MainActivity from this tap.
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
    if (intent?.hasExtra("google.message_id") == true && !PushRoutingState.mainActivityIsLive) {
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
      'android:exported': 'true',
      'android:excludeFromRecents': 'true',
      'android:noHistory': 'true',
      'android:theme': PUSH_ACTIVITY_THEME,
    };
    pushActivity['intent-filter'] = [
      {
        action: [{ $: { 'android:name': 'android.intent.action.MAIN' } }],
        category: [{ $: { 'android:name': 'android.intent.category.LAUNCHER' } }],
      },
    ];

    // FCM asks PackageManager for the default launch intent. Leave only the
    // trampoline in that lookup while preserving MainActivity deep links.
    for (const activity of application.activity) {
      if (activity.$?.['android:name'] !== '.MainActivity') continue;
      activity['intent-filter'] = (activity['intent-filter'] ?? []).filter(
        (filter) => !(filter.action ?? []).some(
          (action) => action.$?.['android:name'] === 'android.intent.action.MAIN',
        ),
      );
    }

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
