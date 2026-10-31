package app.usebeeline.httppool

import android.app.Activity
import android.app.Application
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import com.facebook.react.modules.network.OkHttpClientFactory
import com.facebook.react.modules.network.OkHttpClientProvider
import java.util.Collections
import java.util.WeakHashMap
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient

/**
 * React Native's HTTP client keeps pooled HTTP/2 connections with no read
 * timeout. One that went silently dead (a NAT mapping lost while the phone
 * slept, a network change) takes every later request and never answers.
 * Pinging finds such a connection and closes it; the pool is also emptied of
 * idle connections when the network changes, when the app returns from a long
 * background stay, and when JavaScript reports a request that went unanswered.
 */
object HttpPool {
  /** A connection that misses one pong within this interval is closed. */
  private const val PING_INTERVAL_SECONDS = 5L
  /** A shorter background stay keeps its connections; their NAT mappings survive it. */
  private const val BACKGROUND_STAY_MS = 30_000L
  /** An aborted request releases its connection asynchronously; evict once more after it. */
  private const val RELEASE_GRACE_MS = 1_000L

  private val clients = Collections.newSetFromMap(WeakHashMap<OkHttpClient, Boolean>())
  private val main by lazy { Handler(Looper.getMainLooper()) }
  private var installed = false

  @Synchronized
  fun install(context: Context) {
    if (installed) return
    installed = true
    val app = context.applicationContext
    OkHttpClientProvider.setOkHttpClientFactory(OkHttpClientFactory {
      OkHttpClientProvider.createClientBuilder(app)
        .pingInterval(PING_INTERVAL_SECONDS, TimeUnit.SECONDS)
        .build()
        .also { client -> synchronized(clients) { clients.add(client) } }
    })
    (app as? Application)?.let(::watchForeground)
    runCatching { watchNetwork(app) }
  }

  /** Close every idle pooled connection, so the next request opens a fresh one. */
  fun evictIdle() {
    val pools = synchronized(clients) { clients.map { it.connectionPool } }.distinct()
    for (pool in pools) runCatching { pool.evictAll() }
  }

  fun evictIdleSoon() {
    evictIdle()
    main.postDelayed(::evictIdle, RELEASE_GRACE_MS)
  }

  private fun watchForeground(app: Application) {
    app.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
      private var started = 0
      private var backgroundedAt = 0L
      override fun onActivityStarted(activity: Activity) {
        started += 1
        if (started == 1 && backgroundedAt != 0L &&
          SystemClock.elapsedRealtime() - backgroundedAt >= BACKGROUND_STAY_MS) evictIdle()
      }
      override fun onActivityStopped(activity: Activity) {
        started = maxOf(0, started - 1)
        if (started == 0) backgroundedAt = SystemClock.elapsedRealtime()
      }
      override fun onActivityCreated(activity: Activity, state: Bundle?) = Unit
      override fun onActivityResumed(activity: Activity) = Unit
      override fun onActivityPaused(activity: Activity) = Unit
      override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) = Unit
      override fun onActivityDestroyed(activity: Activity) = Unit
    })
  }

  private fun watchNetwork(context: Context) {
    val connectivity = context.getSystemService(ConnectivityManager::class.java) ?: return
    connectivity.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
      private var current: Network? = null
      override fun onAvailable(network: Network) {
        val previous = current
        current = network
        // The first callback reports the network the app started on.
        if (previous != null && previous != network) evictIdle()
      }
      override fun onLost(network: Network) {
        if (network == current) current = null
        evictIdle()
      }
    })
  }
}
