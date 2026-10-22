package app.usebeeline.modalnavigationbar

import android.os.Build
import android.view.View
import android.view.ViewGroup
import android.view.Window
import com.facebook.react.views.modal.ReactModalHostView
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.Collections
import java.util.WeakHashMap

/**
 * React Native's Modal turns on navigation-bar contrast enforcement for its
 * dialog window (WindowUtil.enableEdgeToEdge). With 3-button navigation,
 * Android then paints a translucent white scrim over the bar, hiding the
 * bottom of every Hull sheet behind a white strip. React Native ships
 * prebuilt, so this clears the flag on each open Modal dialog window instead,
 * and keeps it cleared when React Native re-applies its window settings on a
 * prop update.
 */
class AndroidModalNavigationBarModule : Module() {
  private val guarded: MutableSet<Window> = Collections.newSetFromMap(WeakHashMap())

  override fun definition() = ModuleDefinition {
    Name("AndroidModalNavigationBar")

    Function("clearModalNavigationBarScrim") {
      val activity = appContext.currentActivity
      if (activity != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        activity.runOnUiThread { clearIn(activity.window.decorView) }
      }
    }
  }

  private fun clearIn(view: View) {
    if (view is ReactModalHostView) {
      view.dialog?.window?.let(::clear)
    }
    if (view is ViewGroup) {
      for (index in 0 until view.childCount) clearIn(view.getChildAt(index))
    }
  }

  private fun clear(window: Window) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
    window.isNavigationBarContrastEnforced = false
    if (!guarded.add(window)) return
    window.decorView.viewTreeObserver.addOnPreDrawListener {
      if (window.isNavigationBarContrastEnforced) window.isNavigationBarContrastEnforced = false
      true
    }
  }
}
