package app.usebeeline.voicebackgroundaudio

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Handler
import android.os.Looper
import android.os.Build
import android.os.SystemClock
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class VoiceBackgroundAudioModule : Module() {
  private var stopReceiver: BroadcastReceiver? = null
  private var sessionGeneration = 0L
  private val handler = Handler(Looper.getMainLooper())
  // With the service disabled, retain foreground idle behavior in the app process.
  private val silence = VoiceSilenceTimer(
    schedule = { delayMs, task -> handler.postDelayed(task, delayMs) },
    unschedule = { task -> handler.removeCallbacks(task) },
  )

  override fun definition() = ModuleDefinition {
    Name("VoiceBackgroundAudio")
    Events("stopRequested", "idleRequested")

    OnCreate {
      if (!VoiceAudioService.BACKGROUND_MICROPHONE_ENABLED) return@OnCreate
      val context = appContext.reactContext ?: return@OnCreate
      val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
          when (intent?.action) {
            VoiceAudioService.ACTION_STOP_REQUESTED -> {
              if (intent.getLongExtra(VoiceAudioService.EXTRA_GENERATION, 0L) == sessionGeneration) {
                val stoppedGeneration = sessionGeneration
                sessionGeneration = 0L
                sendEvent("stopRequested", mapOf("generation" to stoppedGeneration))
              }
            }
            VoiceAudioService.ACTION_IDLE_REQUESTED -> {
              // Do not clear sessionGeneration: the JS policy decides whether to
              // park/end or re-arm the deadline after this signal.
              if (intent.getLongExtra(VoiceAudioService.EXTRA_GENERATION, 0L) == sessionGeneration)
                sendEvent("idleRequested", mapOf("generation" to sessionGeneration))
            }
          }
        }
      }
      val filter = IntentFilter().apply {
        addAction(VoiceAudioService.ACTION_STOP_REQUESTED)
        addAction(VoiceAudioService.ACTION_IDLE_REQUESTED)
      }
      if (Build.VERSION.SDK_INT >= 33) {
        context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
      } else {
        @Suppress("DEPRECATION")
        context.registerReceiver(receiver, filter)
      }
      stopReceiver = receiver
    }

    OnDestroy {
      silence.cancel()
      val context = appContext.reactContext
      val receiver = stopReceiver
      if (context != null && receiver != null) {
        try { context.unregisterReceiver(receiver) } catch (_: IllegalArgumentException) {}
      }
      stopReceiver = null
    }

    AsyncFunction("start") { resumeUrl: String? ->
      val context = appContext.reactContext ?: return@AsyncFunction null
      silence.cancel()
      sessionGeneration = SystemClock.elapsedRealtimeNanos()
      val intent = command(context, VoiceAudioService.ACTION_START, resumeUrl = resumeUrl)
      if (VoiceAudioService.BACKGROUND_MICROPHONE_ENABLED) {
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
      }
      sessionGeneration
    }

    AsyncFunction("configureStop") { url: String, token: String, expectedGeneration: Long ->
      if (VoiceAudioService.BACKGROUND_MICROPHONE_ENABLED && sessionGeneration != 0L && sessionGeneration == expectedGeneration)
        VoiceAudioService.stopRequests.configure(expectedGeneration, url, token)
      null
    }

    AsyncFunction("setActivity") { active: Boolean, waitingFor: String?, expectedGeneration: Long ->
      val context = appContext.reactContext ?: return@AsyncFunction null
      if (sessionGeneration == 0L || sessionGeneration != expectedGeneration) return@AsyncFunction null
      silence.cancel(expectedGeneration)
      sendCommand(context, command(context, VoiceAudioService.ACTION_ACTIVITY)
        .putExtra(VoiceAudioService.EXTRA_ACTIVE, active)
        .putExtra(VoiceAudioService.EXTRA_WAITING_FOR, waitingFor))
      null
    }

    AsyncFunction("armSilence") { expectedGeneration: Long ->
      val context = appContext.reactContext ?: return@AsyncFunction null
      if (sessionGeneration == 0L || sessionGeneration != expectedGeneration) return@AsyncFunction null
      if (!VoiceAudioService.BACKGROUND_MICROPHONE_ENABLED) {
        silence.arm(expectedGeneration) { fired ->
          if (sessionGeneration == fired) sendEvent("idleRequested", mapOf("generation" to fired))
        }
      }
      sendCommand(context, command(context, VoiceAudioService.ACTION_ARM_SILENCE))
      null
    }

    AsyncFunction("cancelSilence") { expectedGeneration: Long ->
      val context = appContext.reactContext ?: return@AsyncFunction null
      if (sessionGeneration == 0L || sessionGeneration != expectedGeneration) return@AsyncFunction null
      silence.cancel(expectedGeneration)
      sendCommand(context, command(context, VoiceAudioService.ACTION_CANCEL_SILENCE))
      null
    }

    AsyncFunction("endForIdle") { resumeUrl: String?, expectedGeneration: Long ->
      val context = appContext.reactContext ?: return@AsyncFunction null
      if (sessionGeneration == 0L || sessionGeneration != expectedGeneration) return@AsyncFunction null
      silence.cancel(expectedGeneration)
      sendCommand(context, command(context, VoiceAudioService.ACTION_IDLE_END, resumeUrl = resumeUrl))
      sessionGeneration = 0L
      null
    }

    AsyncFunction("stop") { expectedGeneration: Long ->
      val context = appContext.reactContext ?: return@AsyncFunction null
      if (sessionGeneration == 0L || sessionGeneration != expectedGeneration) return@AsyncFunction null
      silence.cancel(expectedGeneration)
      sendCommand(context, command(context, VoiceAudioService.ACTION_STOP))
      sessionGeneration = 0L
      null
    }
  }

  private fun sendCommand(context: Context, intent: Intent) {
    if (VoiceAudioService.BACKGROUND_MICROPHONE_ENABLED) context.startService(intent)
  }

  private fun command(context: Context, action: String, resumeUrl: String? = null): Intent =
    Intent(context, VoiceAudioService::class.java)
      .setAction(action)
      .putExtra(VoiceAudioService.EXTRA_GENERATION, sessionGeneration)
      .putExtra(VoiceAudioService.EXTRA_RESUME_URL, resumeUrl)
}
