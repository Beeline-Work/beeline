package app.usebeeline.crashtrace

/** The public Android debuggerd tombstone.proto fields; unknown/OEM fields are skipped.
 * https://android.googlesource.com/platform/system/core/+/main/debuggerd/proto/tombstone.proto
 * No memory, registers, command line, or log buffers leave the device.
 */
internal object TombstoneTrace {
  private data class Field(val number: Int, val integer: Long = 0, val bytes: ByteArray = byteArrayOf())
  private fun fields(bytes: ByteArray): List<Field> {
    var offset = 0
    fun integer(): Long {
      var value = 0L
      for (shift in 0..63 step 7) {
        require(offset < bytes.size)
        val byte = bytes[offset++].toInt() and 255
        value = value or ((byte and 127).toLong() shl shift)
        if (byte and 128 == 0) return value
      }
      error("Invalid tombstone varint")
    }
    val result = mutableListOf<Field>()
    while (offset < bytes.size) {
      val tag = integer().toInt()
      require(tag ushr 3 != 0)
      when (tag and 7) {
        0 -> result.add(Field(tag ushr 3, integer()))
        1 -> offset += 8
        2 -> {
          val length = integer()
          require(length in 0..(bytes.size - offset).toLong())
          val end = offset + length.toInt()
          result.add(Field(tag ushr 3, bytes = bytes.copyOfRange(offset, end)))
          offset = end
        }
        5 -> offset += 4
        else -> error("Invalid tombstone wire type")
      }
      require(offset <= bytes.size)
    }
    return result
  }
  private fun List<Field>.text(number: Int) = firstOrNull { it.number == number }?.bytes?.toString(Charsets.UTF_8).orEmpty()
  private fun List<Field>.integer(number: Int) = firstOrNull { it.number == number }?.integer ?: 0

  fun decode(bytes: ByteArray): Pair<String, String> {
    val root = fields(bytes)
    val signal = root.firstOrNull { it.number == 10 }?.let { fields(it.bytes).text(2) }.orEmpty()
    val message = listOf(signal, root.text(14)).filter { it.isNotEmpty() }.joinToString(": ").take(2048)
    val tid = root.integer(6)
    val entry = root.filter { it.number == 16 }.map { fields(it.bytes) }.firstOrNull { it.integer(1) == tid }
      ?: return message to ""
    val thread = entry.firstOrNull { it.number == 2 }?.let { fields(it.bytes) } ?: return message to ""
    val frames = thread.filter { it.number == 4 }.take(64).mapIndexed { index, field ->
      val frame = fields(field.bytes)
      "#${index.toString().padStart(2, '0')} pc ${frame.integer(1).toString(16)} ${frame.text(6)} (${frame.text(4)}+${frame.integer(5)}) [${frame.text(8)}]"
    }
    return message to ("Thread: ${thread.text(2)} ($tid)\n" + frames.joinToString("\n")).take(4096)
  }
}
