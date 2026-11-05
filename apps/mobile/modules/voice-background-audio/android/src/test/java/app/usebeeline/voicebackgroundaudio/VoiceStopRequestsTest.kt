package app.usebeeline.voicebackgroundaudio

import org.junit.Assert.*
import org.junit.Test
import java.net.ServerSocket
import java.util.concurrent.CopyOnWriteArrayList

class VoiceStopRequestsTest {
  @Test fun parkedStopPostsOnceWithoutJavaScriptAndCannotStopSuccessor() {
    val server = ServerSocket(0)
    server.soTimeout = 5000
    val posts = CopyOnWriteArrayList<String>()
    val worker = Thread {
      repeat(2) {
        server.accept().use { socket ->
          socket.soTimeout = 5000
          val reader = socket.getInputStream().bufferedReader()
          val method = reader.readLine()
          var length = 0
          while (true) {
            val line = reader.readLine() ?: break
            if (line.isEmpty()) break
            if (line.startsWith("Content-Length:", true)) length = line.substringAfter(':').trim().toInt()
          }
          val body = CharArray(length)
          var offset = 0
          while (offset < length) offset += reader.read(body, offset, length - offset)
          posts.add("$method ${String(body)}")
          socket.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".toByteArray())
        }
      }
    }.apply { isDaemon = true; start() }
    try {
      val requests = VoiceStopRequests()
      val url = "http://127.0.0.1:${server.localPort}/native-stop"
      requests.configure(1, url, "session-capability")
      requests.take(1)!!.send()
      assertNull(requests.take(1))
      requests.configure(2, url, "session-capability")
      requests.configure(1, "http://invalid", "stale")
      assertNull(requests.take(1))
      requests.take(2)!!.send()
      worker.join(5000)
      assertFalse(worker.isAlive)
      assertEquals(listOf(
        "POST /native-stop HTTP/1.1 {\"token\":\"session-capability\"}",
        "POST /native-stop HTTP/1.1 {\"token\":\"session-capability\"}"
      ), posts.toList())
    } finally { server.close() }
  }
}
