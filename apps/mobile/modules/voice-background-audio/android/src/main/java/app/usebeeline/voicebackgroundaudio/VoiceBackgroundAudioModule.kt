package app.usebeeline.voicebackgroundaudio

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.SystemClock
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class VoiceBackgroundAudioModule : Module() {
  private var stopReceiver: BroadcastReceiver? = null
  private var sessionGeneration = 0L

  override fun definition() = ModuleDefinition {
    Name("VoiceBackgroundAudio")
    Events("stopRequested")

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

          }
        }
      }
      val filter = IntentFilter().apply {
        addAction(VoiceAudioService.ACTION_STOP_REQUESTED)
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
      val context = appContext.reactContext
      val receiver = stopReceiver
      if (context != null && receiver != null) {
        try { context.unregisterReceiver(receiver) } catch (_: IllegalArgumentException) {}
      }
      stopReceiver = null
    }

    AsyncFunction("start") { resumeUrl: String? ->
      val context = appContext.reactContext ?: return@AsyncFunction null
      sessionGeneration = SystemClock.elapsedRealtimeNanos()
      val intent = command(context, VoiceAudioService.ACTION_START)
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

    AsyncFunction("stop") { expectedGeneration: Long ->
      val context = appContext.reactContext ?: return@AsyncFunction null
      if (sessionGeneration == 0L || sessionGeneration != expectedGeneration) return@AsyncFunction null
      sendCommand(context, command(context, VoiceAudioService.ACTION_STOP))
      sessionGeneration = 0L
      null
    }
  }

  private fun sendCommand(context: Context, intent: Intent) {
    if (VoiceAudioService.BACKGROUND_MICROPHONE_ENABLED) context.startService(intent)
  }

  private fun command(context: Context, action: String): Intent =
    Intent(context, VoiceAudioService::class.java)
      .setAction(action)
      .putExtra(VoiceAudioService.EXTRA_GENERATION, sessionGeneration)
}
