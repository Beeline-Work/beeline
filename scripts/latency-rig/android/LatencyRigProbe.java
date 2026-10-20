package app.usebeeline;
import android.app.Activity;
import android.graphics.Rect;
import android.os.SystemClock;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;
import org.json.JSONObject;
import java.lang.ref.WeakReference;
/** Observes existing draws without accessibility polling or JavaScript callbacks. */
public final class LatencyRigProbe {
  private static WeakReference<View> root = new WeakReference<>(null);
  private static Pending pending;
  private static final class Pending {
    final String needle, name, entry;
    long startNanos, startMs;
    boolean submitted;
    Pending(String n, String c, String e) { needle=n; name=c; entry=e; }
  }
  public static synchronized void expect(String needle, String name, String entry) {
    if (needle == null || !needle.matches("[a-f0-9]{16}") || name == null ||
        !("room-list".equals(entry) || "push".equals(entry) || "send-text".equals(entry))) throw new IllegalArgumentException("Invalid fixture probe");
    pending = new Pending(needle, name, entry);
  }
  public static synchronized void begin(String entry) {
    Pending p = pending;
    if (p == null || p.startNanos != 0 || !p.entry.equals(entry)) return;
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
    View room = roomScreen(view);
    if (room == null) return;
    int composerTop = composerTop(room);
    if (composerTop == Integer.MAX_VALUE || !visibleRow(room, p.needle, composerTop)) return;
    p.submitted = true;
    view.getViewTreeObserver().registerFrameCommitCallback(() -> {
      long paintMs = p.startMs + (SystemClock.elapsedRealtimeNanos() - p.startNanos) / 1000000;
      try {
        JSONObject mark = new JSONObject();
        mark.put("probe", "native-frame-commit-v1"); mark.put("case", p.name); mark.put("needle", p.needle);
        mark.put("startMs", p.startMs); mark.put("paintMs", paintMs);
        Log.w("LATENCY_NATIVE", "LATENCY_VISIBLE " + mark.toString());
      } catch (Exception error) { throw new RuntimeException(error); }
      synchronized (LatencyRigProbe.class) { if (pending == p) pending = null; }
    });
  }
  private static View roomScreen(View view) {
    if (view.isShown() && view.getAlpha() >= 0.9f && "Message".contentEquals(view.getContentDescription() == null ? "" : view.getContentDescription())) {
      View parent = view;
      while (parent.getParent() instanceof View) {
        parent = (View)parent.getParent();
        if (parent.getClass().getName().equals("com.swmansion.rnscreens.Screen")) return parent;
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
