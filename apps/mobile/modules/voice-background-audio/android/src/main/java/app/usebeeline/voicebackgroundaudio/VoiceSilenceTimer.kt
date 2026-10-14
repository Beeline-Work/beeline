package app.usebeeline.voicebackgroundaudio

/**
 * Generation-fenced one-shot silence timer.
 *
 * The owner (JS client policy) arms one deadline at a time and cancels it when
 * speech resumes, the agent speaks, or the session ends. Every deadline carries
 * the generation that armed it, so a late callback or a stale cancel can never
 * fire or clear a successor's deadline.
 *
 * The scheduler is injected: the service passes a Handler(mainLooper) so the
 * deadline runs inside the microphone foreground service rather than React
 * Native's TimingModule, and unit tests pass a fake.
 */
class VoiceSilenceTimer(
  private val schedule: (delayMs: Long, task: Runnable) -> Unit,
  private val unschedule: (task: Runnable) -> Unit,
  private val deadlineMs: Long = DEFAULT_DEADLINE_MS,
) {
  private var pending: Deadline? = null
  private var pendingGeneration = 0L

  /** Arm a fresh deadline for [generation], replacing any previous one. */
  @Synchronized
  fun arm(generation: Long, onIdle: (Long) -> Unit) {
    cancelLocked()
    if (generation <= 0L) return
    pendingGeneration = generation
    val deadline = Deadline(generation, onIdle)
    pending = deadline
    schedule(deadlineMs, deadline)
  }

  /**
   * Cancel the pending deadline. With a [generation], only a deadline armed by
   * that same generation is cleared; a stale cancel is ignored.
   */
  @Synchronized
  fun cancel(generation: Long? = null) {
    if (generation != null && generation != pendingGeneration) return
    cancelLocked()
  }

  @Synchronized
  fun isArmedFor(generation: Long): Boolean = pending != null && pendingGeneration == generation

  private fun cancelLocked() {
    pending?.let { unschedule(it) }
    pending = null
    pendingGeneration = 0L
  }

  private inner class Deadline(
    private val generation: Long,
    private val onIdle: (Long) -> Unit,
  ) : Runnable {
    override fun run() {
      synchronized(this@VoiceSilenceTimer) {
        // A reset or cancel already replaced this deadline; the stale runnable
        // must not fire and must not touch the successor's state.
        if (pending !== this) return
        pending = null
        pendingGeneration = 0L
      }
      onIdle(generation)
    }
  }

  companion object {
    const val DEFAULT_DEADLINE_MS = 20_000L
  }
}
