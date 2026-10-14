package app.usebeeline.voicebackgroundaudio

/** Process-wide fence: an ended session cannot be revived by a queued command. */
class VoiceSessionGate {
  private var generation = 0L
  private var endedGeneration = 0L
  private var running = false

  @Synchronized fun start(candidate: Long): Boolean {
    if (candidate <= endedGeneration || candidate < generation) return false
    generation = candidate
    running = true
    return true
  }

  @Synchronized fun accepts(candidate: Long) = running && candidate == generation

  @Synchronized fun end(candidate: Long): Boolean {
    if (!accepts(candidate)) return false
    endedGeneration = maxOf(endedGeneration, candidate)
    running = false
    return true
  }
}
