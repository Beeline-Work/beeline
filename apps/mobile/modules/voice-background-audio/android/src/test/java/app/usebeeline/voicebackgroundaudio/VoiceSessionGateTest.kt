package app.usebeeline.voicebackgroundaudio

import org.junit.Assert.*
import org.junit.Test

class VoiceSessionGateTest {
  @Test fun stopCannotBeUndoneByQueuedActivityOrStart() {
    val gate = VoiceSessionGate()
    assertFalse(gate.accepts(1))
    assertTrue(gate.start(1))
    assertTrue(gate.end(1))
    assertFalse(gate.accepts(1))
    assertFalse(gate.start(1))
    assertTrue(gate.start(2))
    assertFalse(gate.end(1))
    assertTrue(gate.accepts(2))
  }

  @Test fun delayedOldCallbacksCannotStopSuccessor() {
    val gate = VoiceSessionGate()
    assertTrue(gate.start(10))
    assertTrue(gate.start(11))
    assertFalse(gate.end(10))
    assertFalse(gate.accepts(10))
    assertTrue(gate.accepts(11))
  }
}
