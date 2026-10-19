package app.usebeeline.voicebackgroundaudio

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat

class VoiceAudioService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null
  private var foreground = false
  private var generation = 0L

  override fun onCreate() {
    super.onCreate()
    createChannel()

  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (!BACKGROUND_MICROPHONE_ENABLED) {
      stopSelf(startId)
      return START_NOT_STICKY
    }
    val incomingGeneration = intent?.getLongExtra(EXTRA_GENERATION, 0L) ?: 0L
    val allowed = if (intent?.action == ACTION_START) sessionGate.start(incomingGeneration)
      else sessionGate.accepts(incomingGeneration)
    if (!allowed) {
      if (!foreground) stopSelf(startId)
      return START_NOT_STICKY
    }
    generation = incomingGeneration
    when (intent?.action) {
      ACTION_START -> {
        ensureForeground()
        updateWakeLock()
        updateForegroundNotification()
      }
      ACTION_STOP -> {
        sessionGate.end(generation)
        val endingGeneration = generation
        val request = stopRequests.take(endingGeneration)
        sendBroadcast(Intent(ACTION_STOP_REQUESTED).setPackage(packageName).putExtra(EXTRA_GENERATION, endingGeneration))
        releaseWakeLock()
        val finish = {
          if (generation == endingGeneration) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            foreground = false
            stopSelf(startId)
          }
        }
        if (request == null) finish() else Thread({
          request.send()
          Handler(mainLooper).post { finish() }
        }, "BeelineVoiceStop").start()

      }
    }
    return START_NOT_STICKY
  }

  private fun ensureForeground() {
    if (!BACKGROUND_MICROPHONE_ENABLED) return
    if (Build.VERSION.SDK_INT >= 29) {
      startForeground(NOTIFICATION_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
    } else {
      startForeground(NOTIFICATION_ID, buildNotification())
    }
    foreground = true
  }

  private fun updateForegroundNotification() {
    if (foreground) getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification())
  }

  private fun buildNotification(): Notification {
    val stopIntent = PendingIntent.getService(
      this, STOP_REQUEST_CODE,
      Intent(this, VoiceAudioService::class.java)
        .setAction(ACTION_STOP)
        .putExtra(EXTRA_GENERATION, generation),
      PendingIntent.FLAG_UPDATE_CURRENT or immutableFlag()
    )
    val text = "Call is listening · Leave"
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.ic_btn_speak_now)
      .setContentTitle("Beeline")
      .setContentText(text)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .addAction(0, "Leave", stopIntent)
      .build()
  }

  private fun updateWakeLock() {
    run {
      val pm = getSystemService(POWER_SERVICE) as PowerManager
      if (wakeLock == null) {
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Beeline:VoiceAudio")
          .apply { setReferenceCounted(false) }
      }
      if (wakeLock?.isHeld != true) wakeLock?.acquire()
    }
  }

  private fun releaseWakeLock() {
    try { if (wakeLock?.isHeld == true) wakeLock?.release() } catch (_: RuntimeException) {}
    wakeLock = null
  }

  private fun createChannel() {
    if (Build.VERSION.SDK_INT >= 26) {
      val manager = getSystemService(NotificationManager::class.java)
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "Voice conversation", NotificationManager.IMPORTANCE_LOW)
      )
    }
  }

  private fun immutableFlag() = if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0

  override fun onDestroy() {
    sessionGate.end(generation)
    releaseWakeLock()
    foreground = false
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  companion object {
    // Requires the Google Play foreground-service declaration, the service
    // manifest entry and both permissions allowed in app.config.js.
    const val BACKGROUND_MICROPHONE_ENABLED = true
    const val ACTION_START = "app.usebeeline.voice.START"
    const val ACTION_STOP = "app.usebeeline.voice.STOP"
    const val ACTION_STOP_REQUESTED = "app.usebeeline.voice.STOP_REQUESTED"
    const val EXTRA_GENERATION = "generation"
    val stopRequests = VoiceStopRequests()
    private val sessionGate = VoiceSessionGate()
    private const val CHANNEL_ID = "voice-conversation"
    private const val NOTIFICATION_ID = 4012
    private const val STOP_REQUEST_CODE = 4014
  }
}
