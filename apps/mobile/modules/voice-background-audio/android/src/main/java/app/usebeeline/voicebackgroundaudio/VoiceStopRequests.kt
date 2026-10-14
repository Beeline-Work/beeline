package app.usebeeline.voicebackgroundaudio

import java.net.HttpURLConnection
import java.net.URL

/** Memory-only capability; neither the token nor URL enters an Android Intent. */
class VoiceStopRequests {
  private var generation = 0L
  private var request: VoiceStopRequest? = null

  @Synchronized fun configure(owner: Long, url: String, token: String) {
    if (owner < generation) return
    generation = owner
    request = VoiceStopRequest(url, token)
  }

  @Synchronized fun take(owner: Long): VoiceStopRequest? {
    if (owner != generation) return null
    val current = request
    request = null
    return current
  }
}

class VoiceStopRequest(private val url: String, private val token: String) {
  fun send() {
    // Bounded, idempotent retries on the native thread, independent of RN timers.
    repeat(3) {
      var connection: HttpURLConnection? = null
      try {
        connection = URL(url).openConnection() as HttpURLConnection
        connection.requestMethod = "POST"
        connection.instanceFollowRedirects = false
        connection.connectTimeout = 5000
        connection.readTimeout = 5000
        connection.doOutput = true
        connection.setRequestProperty("Content-Type", "application/json")
        // The server capability consists only of base64url segments and a dot.
        val body = "{\"token\":\"$token\"}".toByteArray(Charsets.UTF_8)
        connection.setFixedLengthStreamingMode(body.size)
        connection.outputStream.use { it.write(body) }
        val status = connection.responseCode
        if (status in 200..299 || status in 400..499) return
      } catch (_: Exception) {
        // A transient connection failure may be retried without waking JS.
      } finally { connection?.disconnect() }
    }
  }
}
