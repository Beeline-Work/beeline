package app.usebeeline.crashtrace

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build
import android.os.Process
import android.util.AtomicFile
import android.util.Log
import java.io.File
import org.json.JSONObject

/** One bounded, private crash receipt. It survives offline launches until the server accepts it. */
internal object CrashTrace {
  private lateinit var context: Context
  private lateinit var receipt: AtomicFile
  private var previousLaunch = 0L
  private var previousRelease = JSONObject()
  @Volatile private var release = JSONObject()

  fun install(app: Context) {
    context = app.applicationContext
    receipt = AtomicFile(File(context.noBackupFilesDir, "native-crash.json"))
    val prefs = context.getSharedPreferences("native-crash", Context.MODE_PRIVATE)
    previousLaunch = prefs.getLong("launch", System.currentTimeMillis())
    previousRelease = runCatching { JSONObject(prefs.getString("release", "{}")!!) }.getOrDefault(JSONObject())
    release = metadata()
    prefs.edit().putLong("launch", System.currentTimeMillis()).putString("release", release.toString()).commit()
    val delegate = Thread.getDefaultUncaughtExceptionHandler()
    Thread.setDefaultUncaughtExceptionHandler { thread, error ->
      try {
        runCatching {
          val report = JSONObject(release.toString())
          val timestamp = System.currentTimeMillis()
          report.put("id", "$timestamp-${Process.myPid()}").put("timestamp", timestamp)
            .put("message", error.toString().take(2048))
            .put("stack", "Thread: ${thread.name}\n${Log.getStackTraceString(error)}".take(4096))
          save(report)
        }
      } finally {
        // Preserve Android's fatal-crash behavior and Play vitals collection.
        if (delegate != null) delegate.uncaughtException(thread, error)
        else { Process.killProcess(Process.myPid()); kotlin.system.exitProcess(10) }
      }
    }
  }

  private fun metadata() = JSONObject().put("device", "${Build.MANUFACTURER} ${Build.MODEL}".take(128))
    .put("platformVersion", "${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})".take(64))
    .put("appVersion", (context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "").take(64))
    .put("releaseSha", "").put("runtimeVersion", context.packageManager
      .getApplicationInfo(context.packageName, android.content.pm.PackageManager.GET_META_DATA)
      .metaData?.getString("expo.modules.updates.EXPO_RUNTIME_VERSION") ?: "").put("updateId", "")

  @Synchronized fun setReleaseContext(sha: String, runtime: String, update: String) {
    if (!::context.isInitialized) return
    release = metadata().put("releaseSha", sha.take(128)).apply {
      if (runtime.isNotEmpty()) put("runtimeVersion", runtime.take(64))
    }.put("updateId", update.take(64))
    context.getSharedPreferences("native-crash", Context.MODE_PRIVATE).edit().putString("release", release.toString()).apply()
  }

  private fun save(report: JSONObject) {
    val output = receipt.startWrite()
    try { output.write(report.toString().toByteArray()); receipt.finishWrite(output) }
    catch (error: Throwable) { receipt.failWrite(output); throw error }
  }

  @Synchronized fun pending(): JSONObject? = runCatching {
    if (!::receipt.isInitialized) return null
    if (receipt.baseFile.exists()) return JSONObject(receipt.openRead().use { it.readBytes().toString(Charsets.UTF_8) })
    if (Build.VERSION.SDK_INT < 30) return null
    val prefs = context.getSharedPreferences("native-crash", Context.MODE_PRIVATE)
    val acknowledged = prefs.getLong("acknowledged", 0)
    val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    val exit = manager.getHistoricalProcessExitReasons(context.packageName, 0, 8).firstOrNull {
      it.processName == context.packageName && it.timestamp >= previousLaunch && it.timestamp > acknowledged &&
        (it.reason == ApplicationExitInfo.REASON_CRASH_NATIVE || it.reason == ApplicationExitInfo.REASON_CRASH)
    } ?: return null
    val report = JSONObject(previousRelease.toString())
    var message = exit.description ?: "Native crash (status ${exit.status})"
    var stack = "Android did not retain a crash trace."
    if (exit.reason == ApplicationExitInfo.REASON_CRASH_NATIVE && Build.VERSION.SDK_INT >= 31) {
      runCatching {
        exit.traceInputStream?.use { stream ->
          // Tombstones also contain memory and logs: decode only the crashing thread's backtrace.
          val bytes = stream.takeBytes(2 * 1024 * 1024)
          val trace = TombstoneTrace.decode(bytes)
          message = trace.first.ifEmpty { message }
          stack = trace.second.ifEmpty { stack }
        }
      }
    }
    report.put("id", "${exit.timestamp}-${exit.pid}").put("timestamp", exit.timestamp)
      .put("message", message.take(2048)).put("stack", stack.take(4096))
    save(report)
    report
  }.getOrNull()

  @Synchronized fun acknowledge(id: String) {
    val report = pending() ?: return
    if (report.optString("id") != id) return
    context.getSharedPreferences("native-crash", Context.MODE_PRIVATE).edit()
      .putLong("acknowledged", System.currentTimeMillis()).commit()
    receipt.delete()
  }
}

private fun java.io.InputStream.takeBytes(limit: Int): ByteArray {
  val output = java.io.ByteArrayOutputStream()
  val buffer = ByteArray(8192)
  while (output.size() < limit) {
    val size = read(buffer, 0, minOf(buffer.size, limit - output.size()))
    if (size < 0) break
    output.write(buffer, 0, size)
  }
  return output.toByteArray()
}
