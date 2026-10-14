package app.usebeeline.voicebackgroundaudio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceSilenceTimerTest {
  private class FakeScheduler {
    val tasks = LinkedHashMap<Runnable, Long>()
    val cancelled = mutableListOf<Runnable>()
    fun schedule(delayMs: Long, task: Runnable) { tasks[task] = delayMs }
    fun unschedule(task: Runnable) { tasks.remove(task); cancelled.add(task) }
    fun fire(task: Runnable) { task.run() }
    fun fireNext(): Runnable { val task = tasks.keys.first(); task.run(); return task }
    val pending get() = tasks.size
  }

  private fun timer(fake: FakeScheduler) = VoiceSilenceTimer(fake::schedule, fake::unschedule)

  @Test fun onlyFiresOnceAfterTheDeadline() {
    val fake = FakeScheduler()
    val timer = timer(fake)
    val idle = mutableListOf<Long>()
    timer.arm(7) { idle.add(it) }
    assertEquals(1, fake.pending)
    assertEquals(listOf(20_000L), fake.tasks.values.toList())
    val task = fake.fireNext()
    assertEquals(listOf(7L), idle)
    assertFalse(timer.isArmedFor(7))
    // A second run of the same callback is a no-op, so a late scheduler tick
    // cannot emit idleRequested twice.
    fake.fire(task)
    assertEquals(listOf(7L), idle)
  }

  @Test fun armResetsAnyPreviousDeadline() {
    val fake = FakeScheduler()
    val timer = timer(fake)
    val idle = mutableListOf<Long>()
    timer.arm(1) { idle.add(it) }
    val first = fake.tasks.keys.first()
    timer.arm(1) { idle.add(it) }
    assertEquals(1, fake.pending)
    assertTrue(fake.cancelled.contains(first))
    fake.fire(first)
    assertTrue(idle.isEmpty())
    fake.fireNext()
    assertEquals(listOf(1L), idle)
  }

  @Test fun staleCancelDoesNotClearSuccessor() {
    val fake = FakeScheduler()
    val timer = timer(fake)
    val idle = mutableListOf<Long>()
    timer.arm(2) { idle.add(it) }
    timer.cancel(1)
    assertTrue(timer.isArmedFor(2))
    fake.fireNext()
    assertEquals(listOf(2L), idle)
  }

  @Test fun ownGenerationCancelClearsDeadline() {
    val fake = FakeScheduler()
    val timer = timer(fake)
    val idle = mutableListOf<Long>()
    timer.arm(3) { idle.add(it) }
    timer.cancel(3)
    assertFalse(timer.isArmedFor(3))
    assertTrue(idle.isEmpty())
  }

  @Test fun firedGenerationIsTheOneThatArmedTheDeadline() {
    val fake = FakeScheduler()
    val timer = timer(fake)
    val idle = mutableListOf<Long>()
    timer.arm(4) { idle.add(it) }
    timer.arm(5) { idle.add(it) }
    fake.fireNext()
    assertEquals(listOf(5L), idle)
  }

  @Test fun nonPositiveGenerationIsIgnored() {
    val fake = FakeScheduler()
    val timer = timer(fake)
    timer.arm(0) { error("must not fire") }
    assertEquals(0, fake.pending)
    assertFalse(timer.isArmedFor(0))
  }

  @Test fun cancelWithoutGenerationClearsEverything() {
    val fake = FakeScheduler()
    val timer = timer(fake)
    timer.arm(9) { error("must not fire") }
    timer.cancel()
    assertEquals(0, fake.pending)
    assertFalse(timer.isArmedFor(9))
  }
}
