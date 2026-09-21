package app.usebeeline.launchappearance

import android.app.UiModeManager
import android.content.Context
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Persists the in-app Appearance choice as the application's night mode so
 * the next Android 12+ system splash resolves the existing night-qualified
 * splash resources (cream vs aubergine) instead of the system theme.
 *
 * Official guidance: UiModeManager.setApplicationNightMode on API 31+.
 * Never call MODE_NIGHT_AUTO here — that is time-of-day, not follow-system.
 * The app's effective appearance is always light or dark (default dark) and
 * is never follow-system, so every cold start pins this mode; the only
 * unpinned window is before the first JS start after a fresh install.
 */
class AndroidLaunchAppearanceModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AndroidLaunchAppearance")

    Function("setNightMode") { mode: String ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
        return@Function
      }
      val nightMode = when (mode) {
        "light" -> UiModeManager.MODE_NIGHT_NO
        "dark" -> UiModeManager.MODE_NIGHT_YES
        else -> return@Function
      }
      val context = appContext.reactContext ?: return@Function
      val uiModeManager = context.getSystemService(Context.UI_MODE_SERVICE) as? UiModeManager
        ?: return@Function
      uiModeManager.setApplicationNightMode(nightMode)
    }
  }
}
