package app.usebeeline;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
/** Shell-only receiver, generated exclusively into local fixture APKs. */
public final class LatencyRigReceiver extends BroadcastReceiver {
  @Override public void onReceive(Context context, Intent intent) {
    if ("app.usebeeline.LATENCY_RIG_EXPECT".equals(intent.getAction()))
      LatencyRigProbe.expect(intent.getStringExtra("needle"), intent.getStringExtra("case"), intent.getStringExtra("entry"));
  }
}
