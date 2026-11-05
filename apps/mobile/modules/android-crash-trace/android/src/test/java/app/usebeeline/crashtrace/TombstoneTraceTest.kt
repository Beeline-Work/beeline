package app.usebeeline.crashtrace

import org.junit.Assert.*
import org.junit.Test

class TombstoneTraceTest {
  private fun varint(value: Long): ByteArray {
    var rest = value; val bytes = mutableListOf<Byte>()
    do { val low = rest and 127; rest = rest ushr 7; bytes.add((low or if (rest != 0L) 128 else 0).toByte()) } while (rest != 0L)
    return bytes.toByteArray()
  }
  private fun number(field: Int, value: Long) = varint((field * 8).toLong()) + varint(value)
  private fun data(field: Int, value: ByteArray) = varint((field * 8 + 2).toLong()) + varint(value.size.toLong()) + value
  private fun text(field: Int, value: String) = data(field, value.toByteArray())

  @Test fun extractsOnlyTheCrashingThreadAndSkipsPrivateMemoryAndLogs() {
    val frame = number(1, 0x1234) + text(4, "AudioSession::start") + text(6, "libwebrtc.so") + text(8, "build-id")
    val crashed = number(1, 42) + text(2, "audio-thread") + data(4, frame)
    val other = number(1, 7) + text(2, "unrelated-private-thread")
    val tombstone = number(6, 42) + data(10, text(2, "SIGABRT")) + text(14, "Audio failure") +
      data(16, number(1, 7) + data(2, other)) + data(16, number(1, 42) + data(2, crashed)) +
      text(17, "private-memory") + text(18, "private-log") + number(1000, 1)
    val (message, stack) = TombstoneTrace.decode(tombstone)
    assertEquals("SIGABRT: Audio failure", message)
    assertTrue(stack.contains("audio-thread (42)")); assertTrue(stack.contains("pc 1234 libwebrtc.so (AudioSession::start+0) [build-id]"))
    assertFalse(stack.contains("private"))
  }
  @Test fun boundsBacktraceAndRejectsCorruption() {
    val frame = text(6, "x".repeat(200))
    val thread = text(2, "native") + (1..100).fold(byteArrayOf()) { bytes, _ -> bytes + data(4, frame) }
    val tombstone = number(6, 1) + data(16, number(1, 1) + data(2, thread))
    assertEquals(4096, TombstoneTrace.decode(tombstone).second.length)
    assertThrows(IllegalArgumentException::class.java) { TombstoneTrace.decode(byteArrayOf(0x82.toByte())) }
    assertThrows(IllegalArgumentException::class.java) { TombstoneTrace.decode(byteArrayOf(10, 127)) }
  }
}
