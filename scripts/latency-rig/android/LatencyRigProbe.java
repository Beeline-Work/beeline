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
  private static final com.facebook.react.bridge.ReactMarker.FabricMarkerListener FABRIC_LISTENER =
    LatencyRigProbe::fabricMarker;
  private static org.json.JSONArray fabricEvents;
  public static synchronized void recordFabric(android.content.Context context, boolean enabled) {
    if (enabled) { fabricEvents = new org.json.JSONArray(); return; }
    try (java.io.FileWriter out = new java.io.FileWriter(
        new java.io.File(context.getExternalFilesDir(null), "latency-fabric.json"))) {
      JSONObject result = new JSONObject();
      result.put("probe", "react-fabric-markers-v1");
      result.put("epochOffsetMs", System.currentTimeMillis() - SystemClock.uptimeMillis());
      result.put("events", fabricEvents);
      out.write(result.toString());
      fabricEvents = null;
    } catch (Exception error) { throw new RuntimeException(error); }
  }
  private static synchronized void fabricMarker(com.facebook.react.bridge.ReactMarkerConstants name,
      String tag, int instanceKey, long timestamp) {
    if (fabricEvents == null) return;
    try {
      JSONObject event = new JSONObject();
      event.put("name", name.name()); event.put("commit", instanceKey);
      event.put("uptimeMs", timestamp); event.put("observedUptimeMs", SystemClock.uptimeMillis());
      fabricEvents.put(event);
    } catch (org.json.JSONException error) { throw new RuntimeException(error); }
  }
  /** Dumps real mounted Views; flattened Fabric nodes are deliberately absent. */
  public static void dumpViews(android.content.Context context) {
    View view = root.get();
    if (view == null) throw new IllegalStateException("No fixture activity attached");
    view.post(() -> {
      try {
        JSONObject dump = new JSONObject();
        dump.put("probe", "mounted-native-views-v1");
        dump.put("capturedAtMs", System.currentTimeMillis());
        dump.put("tree", describeView(view));
        try (java.io.FileWriter out = new java.io.FileWriter(
            new java.io.File(context.getExternalFilesDir(null), "latency-views.json"))) {
          out.write(dump.toString());
        }
        Log.w("LATENCY_VIEWS", "saved");
      } catch (Exception error) { throw new RuntimeException(error); }
    });
  }
  private static JSONObject describeView(View view) throws org.json.JSONException {
    JSONObject node = new JSONObject();
    node.put("class", view.getClass().getName());
    node.put("id", view.getId());
    node.put("shown", view.isShown());
    node.put("alpha", view.getAlpha());
    node.put("width", view.getWidth()); node.put("height", view.getHeight());
    int[] location = new int[2]; view.getLocationOnScreen(location);
    node.put("x", location[0]); node.put("y", location[1]);
    node.put("description", view.getContentDescription());
    node.put("testId", view.getTag(com.facebook.react.R.id.react_test_id));
    node.put("nativeId", view.getTag(com.facebook.react.R.id.view_tag_native_id));
    if (view instanceof TextView) node.put("text", ((TextView)view).getText().toString());
    org.json.JSONArray children = new org.json.JSONArray();
    if (view instanceof ViewGroup) {
      ViewGroup group = (ViewGroup)view;
      for (int i=0; i<group.getChildCount(); i++) children.put(describeView(group.getChildAt(i)));
    }
    node.put("children", children);
    return node;
  }
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
        !("room-list".equals(entry) || "push".equals(entry) || "send-text".equals(entry) || "key".equals(entry))) throw new IllegalArgumentException("Invalid fixture probe");
    pending = new Pending(needle, name, entry);
  }
  public static synchronized void begin(String entry) {
    Pending p = pending;
    if (p == null || p.startNanos != 0 || !p.entry.equals(entry)) return;
    p.profiled = profiling;
    p.startMs = System.currentTimeMillis();
    p.startNanos = SystemClock.elapsedRealtimeNanos();
    View view = root.get();
    if (view != null) view.postInvalidateOnAnimation();
  }
  public static void attach(Activity activity) {
    com.facebook.react.bridge.ReactMarker.addFabricListener(FABRIC_LISTENER);
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
    if (composerTop == Integer.MAX_VALUE || !("key".equals(p.entry)
        ? visibleComposer(room, p.needle) : visibleRow(room, p.needle, composerTop))) return;
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
