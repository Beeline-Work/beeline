package app.usebeeline.voicebackgroundaudio

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioManager
import android.media.ToneGenerator
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat

class VoiceAudioService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null
  private var active = true
  private var waitingFor: String? = null
  private var resumeUrl: String? = null
  private var foreground = false
  private var generation = 0L
  private var tone: ToneGenerator? = null

  override fun onCreate() {
    super.onCreate()
    createChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
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
        resumeUrl = intent.getStringExtra(EXTRA_RESUME_URL) ?: resumeUrl
        active = true
        waitingFor = null
        ensureForeground()
        updateWakeLock()
        updateForegroundNotification()
      }
      ACTION_ACTIVITY -> {
        intent.getStringExtra(EXTRA_RESUME_URL)?.let { resumeUrl = it }
        active = intent.getBooleanExtra(EXTRA_ACTIVE, false)
        waitingFor = intent.getStringExtra(EXTRA_WAITING_FOR)
        // Keep the mic foreground service alive while parked. Only JS controls
        // capture/replay; this active bit owns the wake lock and notification.
        ensureForeground()
        updateWakeLock()
        updateForegroundNotification()
      }
      ACTION_IDLE_END -> {
        sessionGate.end(generation)
        resumeUrl = intent.getStringExtra(EXTRA_RESUME_URL) ?: resumeUrl
        active = true
        updateWakeLock()
        playSoftChime()
        stopForeground(STOP_FOREGROUND_REMOVE)
        foreground = false
        postResumeNotification()
        val endingGeneration = generation
        Handler(mainLooper).postDelayed({
          if (generation == endingGeneration) { releaseWakeLock(); stopSelf(startId) }
        }, 250)
      }
      ACTION_STOP -> {
        sessionGate.end(generation)
        sendBroadcast(Intent(ACTION_STOP_REQUESTED).setPackage(packageName).putExtra(EXTRA_GENERATION, generation))
        releaseWakeLock()
        stopForeground(STOP_FOREGROUND_REMOVE)
        foreground = false
        stopSelf(startId)
      }
    }
    return START_NOT_STICKY
  }

  private fun ensureForeground() {
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
    val text = if (!active && !waitingFor.isNullOrBlank()) {
      "Waiting for $waitingFor… · Stop"
    } else {
      "Conversation is listening · Stop"
    }
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.ic_btn_speak_now)
      .setContentTitle("Beeline")
      .setContentText(text)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .addAction(0, "Stop", stopIntent)
      .build()
  }

  private fun postResumeNotification() {
    val launch = packageManager.getLaunchIntentForPackage(packageName)?.apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      resumeUrl?.let { data = Uri.parse(it) }
    } ?: return
    val content = PendingIntent.getActivity(
      this, RESUME_REQUEST_CODE, launch,
      PendingIntent.FLAG_UPDATE_CURRENT or immutableFlag()
    )
    val notification = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.ic_btn_speak_now)
      .setContentTitle("Conversation ended")
      .setContentText("Tap to return to your Room and start again")
      .setAutoCancel(true)
      .setContentIntent(content)
      .build()
    getSystemService(NotificationManager::class.java).notify(RESUME_NOTIFICATION_ID, notification)
  }

  private fun updateWakeLock() {
    if (active) {
      val pm = getSystemService(POWER_SERVICE) as PowerManager
      if (wakeLock == null) {
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Beeline:VoiceAudio")
          .apply { setReferenceCounted(false) }
      }
      if (wakeLock?.isHeld != true) wakeLock?.acquire()
    } else {
      releaseWakeLock()
    }
  }

  private fun releaseWakeLock() {
    try { if (wakeLock?.isHeld == true) wakeLock?.release() } catch (_: RuntimeException) {}
    wakeLock = null
  }

  private fun playSoftChime() {
    try {
      tone?.release()
      tone = ToneGenerator(AudioManager.STREAM_NOTIFICATION, 55).also {
        it.startTone(ToneGenerator.TONE_PROP_ACK, 180)
        Handler(mainLooper).postDelayed({
          it.release()
          if (tone === it) tone = null
        }, 250)
      }
    } catch (_: RuntimeException) {
      tone = null
    }
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
    tone?.release()
    tone = null
    foreground = false
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  companion object {
    const val ACTION_START = "app.usebeeline.voice.START"
    const val ACTION_ACTIVITY = "app.usebeeline.voice.ACTIVITY"
    const val ACTION_IDLE_END = "app.usebeeline.voice.IDLE_END"
    const val ACTION_STOP = "app.usebeeline.voice.STOP"
    const val ACTION_STOP_REQUESTED = "app.usebeeline.voice.STOP_REQUESTED"
    const val EXTRA_ACTIVE = "active"
    const val EXTRA_WAITING_FOR = "waitingFor"
    const val EXTRA_RESUME_URL = "resumeUrl"
    const val EXTRA_GENERATION = "generation"
    private val sessionGate = VoiceSessionGate()
    private const val CHANNEL_ID = "voice-conversation"
    private const val NOTIFICATION_ID = 4012
    private const val RESUME_NOTIFICATION_ID = 4013
    private const val STOP_REQUEST_CODE = 4014
    private const val RESUME_REQUEST_CODE = 4015
  }
}
