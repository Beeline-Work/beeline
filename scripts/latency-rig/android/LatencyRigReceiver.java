package app.usebeeline;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
/** Shell-only receiver, generated exclusively into local fixture APKs. */
public final class LatencyRigReceiver extends BroadcastReceiver {
  @Override public void onReceive(Context context, Intent intent) {
    if ("app.usebeeline.LATENCY_RIG_PROFILE".equals(intent.getAction()) &&
        ("fabric-start".equals(intent.getStringExtra("action")) ||
         "fabric-stop".equals(intent.getStringExtra("action")))) {
      LatencyRigProbe.recordFabric(context, "fabric-start".equals(intent.getStringExtra("action")));
      return;
    }
    if ("views".equals(intent.getStringExtra("action")) &&
        "app.usebeeline.LATENCY_RIG_PROFILE".equals(intent.getAction())) {
      LatencyRigProbe.dumpViews(context);
      return;
    }
    if ("app.usebeeline.LATENCY_RIG_PROFILE".equals(intent.getAction())) {
      if ("start".equals(intent.getStringExtra("action"))) {
        com.facebook.hermes.instrumentation.HermesSamplingProfiler.enable();
        LatencyRigProbe.setProfiling(true);
        android.util.Log.w("LATENCY_PROFILE", "started");
      } else if ("stop".equals(intent.getStringExtra("action"))) {
        com.facebook.hermes.instrumentation.HermesSamplingProfiler.dumpSampledTraceToFile(
          new java.io.File(context.getExternalFilesDir(null), "latency-profile.json").getAbsolutePath());
        com.facebook.hermes.instrumentation.HermesSamplingProfiler.disable();
        LatencyRigProbe.setProfiling(false);
        android.util.Log.w("LATENCY_PROFILE", "saved");
      }
      return;
    }
    if ("app.usebeeline.LATENCY_RIG_EXPECT".equals(intent.getAction()))
      LatencyRigProbe.expect(intent.getStringExtra("needle"), intent.getStringExtra("case"), intent.getStringExtra("entry"));
  }
}
