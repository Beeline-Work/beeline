package app.usebeeline;
import android.app.Activity;
import android.graphics.Rect;
import android.os.SystemClock;
import android.util.Log;
import android.view.View;
import android.view.WindowInsets;
import android.widget.EditText;
import android.view.ViewGroup;
import android.widget.TextView;
import org.json.JSONObject;
import java.lang.ref.WeakReference;
/** Observes existing draws without accessibility polling or JavaScript callbacks. */
public final class LatencyRigProbe {
  private static WeakReference<View> root = new WeakReference<>(null);
  private static Pending pending;
  private static boolean profiling;
  public static synchronized void setProfiling(boolean enabled) {
    profiling = enabled;
    if (enabled && pending != null) pending.profiled = true;
  }
  private static final class Pending {
    final String needle, name, entry;
    long startNanos, startMs;
    boolean submitted, profiled;
    Pending(String n, String c, String e) { needle=n; name=c; entry=e; }
  }
  public static synchronized void expect(String needle, String name, String entry) {
    if (needle == null || !needle.matches("[a-f0-9]{16}") || name == null ||
        !("room-list".equals(entry) || "push".equals(entry) || "send-text".equals(entry) || "key".equals(entry) || isTap(entry))) throw new IllegalArgumentException("Invalid fixture probe");
    pending = new Pending(needle, name, entry);
  }
  public static synchronized void begin(String entry) {
    Pending p = pending;
    if (p == null || p.startNanos != 0 || !(p.entry.equals(entry) || ("send-text".equals(entry) && isTap(p.entry)))) return;
    p.profiled = profiling;
    p.startMs = System.currentTimeMillis();
    p.startNanos = SystemClock.elapsedRealtimeNanos();
    View view = root.get();
    if (view != null) view.postInvalidateOnAnimation();
  }
  public static void attach(Activity activity) {
    View view = activity.getWindow().getDecorView();
    root = new WeakReference<>(view);
    view.getViewTreeObserver().addOnDrawListener(() -> observe(view));
  }
  private static synchronized void observe(View view) {
    Pending p = pending;
    if (p == null || p.startNanos == 0 || p.submitted || !view.isHardwareAccelerated()) return;
    if (!complete(view, p)) return;
    p.submitted = true;
    view.getViewTreeObserver().registerFrameCommitCallback(() -> {
      long paintMs = p.startMs + (SystemClock.elapsedRealtimeNanos() - p.startNanos) / 1000000;
      try {
        JSONObject mark = new JSONObject();
        mark.put("probe", "native-frame-commit-v1"); mark.put("case", p.name); mark.put("needle", p.needle);
        mark.put("startMs", p.startMs); mark.put("paintMs", paintMs); mark.put("profiled", p.profiled);
        Log.w("LATENCY_NATIVE", "LATENCY_VISIBLE " + mark.toString());
      } catch (Exception error) { throw new RuntimeException(error); }
      synchronized (LatencyRigProbe.class) { if (pending == p) pending = null; }
    });
    // A callback registered during draw runs on the next commit; a static result
    // (such as an empty tab) would otherwise never schedule one.
    view.postInvalidateOnAnimation();
  }
  private static boolean isTap(String entry) {
    return "react-message".equals(entry) || "open-corner".equals(entry)
      || "switch-tabs".equals(entry) || "open-composer".equals(entry);
  }
  private static boolean complete(View view, Pending p) {
    if ("switch-tabs".equals(p.entry))
      return visibleText(view, "No pinned conversations yet.", false);
    View room = roomScreen(view);
    if (room == null) return false;
    if ("open-composer".equals(p.entry)) return focusedComposer(room);
    int top = composerTop(room);
    if (top == Integer.MAX_VALUE) return false;
    if ("react-message".equals(p.entry))
      return visibleRow(room, p.needle, top) && visibleReaction(room, p.needle);
    // Corner completion requires its unique fixture message inside the destination
    // Screen, not the corner title or the parent Room's list preview.
    return "key".equals(p.entry) ? visibleComposer(room, p.needle) : visibleRow(room, p.needle, top);
  }
  private static boolean visibleReaction(View view, String needle) {
    Object tag = view.getTag(com.facebook.react.R.id.react_test_id);
    if (tag instanceof String && ((String)tag).startsWith("reaction-chip-" + needle))
      return visibleText(view, "👍, 2 reactions", true);
    if (view instanceof ViewGroup) {
      ViewGroup group = (ViewGroup)view;
      for (int i=0; i<group.getChildCount(); i++)
        if (visibleReaction(group.getChildAt(i), needle)) return true;
    }
    return false;
  }
  private static boolean visibleText(View view, String text, boolean description) {
    if (!view.isShown() || view.getAlpha() < 0.9f) return false;
    CharSequence value = description ? view.getContentDescription()
      : view instanceof TextView ? ((TextView)view).getText() : null;
    Rect bounds = new Rect();
    if (value != null && (description ? text.contentEquals(value) : value.toString().contains(text))
        && view.getGlobalVisibleRect(bounds) && bounds.height() >= (view instanceof TextView ? ((TextView)view).getLineHeight() : view.getHeight())) return true;
    if (view instanceof ViewGroup) {
      ViewGroup group = (ViewGroup)view;
      for (int i=0; i<group.getChildCount(); i++)
        if (visibleText(group.getChildAt(i), text, description)) return true;
    }
    return false;
  }
  private static boolean focusedComposer(View view) {
    if (!view.isShown() || view.getAlpha() < 0.9f) return false;
    if (view instanceof EditText && view.hasFocus()
        && "Message".contentEquals(view.getContentDescription() == null ? "" : view.getContentDescription())) {
      WindowInsets insets = view.getRootWindowInsets();
      Rect bounds = new Rect();
      return insets != null && insets.isVisible(WindowInsets.Type.ime())
        && view.getGlobalVisibleRect(bounds) && bounds.height() >= ((EditText)view).getLineHeight();
    }
    if (view instanceof ViewGroup) {
      ViewGroup group = (ViewGroup)view;
      for (int i=0; i<group.getChildCount(); i++) if (focusedComposer(group.getChildAt(i))) return true;
    }
    return false;
  }
  private static View roomScreen(View view) {
    if (view.isShown() && view.getAlpha() >= 0.9f && "Message".contentEquals(view.getContentDescription() == null ? "" : view.getContentDescription())) {
      View parent = view;
      while (parent.getParent() instanceof View) {
        parent = (View)parent.getParent();
        if (parent instanceof com.swmansion.rnscreens.Screen) return parent;
      }
    }
    if (view instanceof ViewGroup) {
      ViewGroup group = (ViewGroup)view;
      for (int i=0; i<group.getChildCount(); i++) {
        View room = roomScreen(group.getChildAt(i));
        if (room != null) return room;
      }
    }
    return null;
  }
  private static boolean visibleComposer(View view, String needle) {
    if (!view.isShown() || view.getAlpha() < 0.9f) return false;
    if (view instanceof TextView && "Message".contentEquals(view.getContentDescription() == null ? "" : view.getContentDescription())
        && ((TextView)view).getText().toString().contains(needle)) {
      Rect bounds = new Rect();
      return view.getGlobalVisibleRect(bounds) && bounds.height() >= ((TextView)view).getLineHeight();
    }
    if (view instanceof ViewGroup) {
      ViewGroup group = (ViewGroup)view;
      for (int i = 0; i < group.getChildCount(); i++) if (visibleComposer(group.getChildAt(i), needle)) return true;
    }
    return false;
  }
  private static int composerTop(View view) {
    if (view.isShown() && view.getAlpha() >= 0.9f && "Message".contentEquals(view.getContentDescription() == null ? "" : view.getContentDescription())) {
      Rect bounds = new Rect();
      if (view.getGlobalVisibleRect(bounds)) return bounds.top;
    }
    int top = Integer.MAX_VALUE;
    if (view instanceof ViewGroup) {
      ViewGroup group = (ViewGroup)view;
      for (int i=0; i<group.getChildCount(); i++) top = Math.min(top, composerTop(group.getChildAt(i)));
    }
    return top;
  }
  private static boolean visibleRow(View view, String needle, int composerTop) {
    if (!view.isShown() || view.getAlpha() < 0.9f) return false;
    if (view instanceof TextView && ((TextView)view).getText().toString().contains(needle)) {
      Rect bounds = new Rect();
      if (view.getGlobalVisibleRect(bounds) && Math.min(bounds.bottom, composerTop)-bounds.top >= ((TextView)view).getLineHeight()) return true;
    }
    if (view instanceof ViewGroup) {
      ViewGroup group = (ViewGroup)view;
      for (int i=0; i<group.getChildCount(); i++) if (visibleRow(group.getChildAt(i), needle, composerTop)) return true;
    }
    return false;
  }
}
