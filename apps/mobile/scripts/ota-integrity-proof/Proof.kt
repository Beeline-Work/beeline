package proof

import android.content.Context
import expo.modules.updates.*
import expo.modules.updates.db.*
import expo.modules.updates.db.entity.*
import expo.modules.updates.db.enums.UpdateStatus
import expo.modules.updates.launcher.DatabaseLauncher
import expo.modules.updates.loader.*
import expo.modules.updates.logging.UpdatesLogger
import expo.modules.updates.manifest.*
import expo.modules.updates.selectionpolicy.SelectionPolicy
import kotlinx.coroutines.*
import java.io.File
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder

private val config = UpdatesConfiguration()
private val context = Context()
private val logger = UpdatesLogger()
private fun launcher(directory: File, scope: CoroutineScope) = DatabaseLauncher(
  context, config, directory, FileDownloader(), SelectionPolicy(), logger, scope
)

private class Installation(val root: File, val complete: ByteArray, val embeddedOnly: Boolean = false) {
  val previous = UpdateEntity(1, if (embeddedOnly) UpdateStatus.EMBEDDED else UpdateStatus.READY)
  val latest = UpdateEntity(2)
  val previousAsset = asset("previous", 1)
  val latestAsset = asset("latest", 2)
  val database = UpdatesDatabase(mutableListOf(previous, latest), mutableMapOf(previous.id to previousAsset, latest.id to latestAsset))

  private fun asset(key: String, id: Long) = AssetEntity(key, "hbc").apply {
    this.id = id; relativePath = key; hash = java.security.MessageDigest.getInstance("SHA-256").digest(complete)
    expectedHash = UpdatesUtils.toBase64Url(hash!!)
    if (embeddedOnly && key == "previous") embeddedAssetFilename = "index.android.bundle"
  }

  init {
    root.mkdirs()
    File(root, "previous").writeBytes(complete)
    // Exact cached-file length from Sentry W. The Hermes header still declares the full bundle.
    File(root, "latest").writeBytes(complete.copyOf(5390336))
    EmbeddedManifestUtils.embedded = if (embeddedOnly) EmbeddedUpdate(previous, listOf(previousAsset)) else null
  }

  suspend fun start(scope: CoroutineScope): DatabaseLauncher {
    val launch = launcher(root, scope)
    launch.launch(database)
    val path = launch.launchAssetFile!!
    val file = if (path.startsWith("assets://")) File(root, "previous") else File(path)
    val bytes = file.readBytes()
    val expectedSize = ByteBuffer.wrap(bytes, 32, 4).order(ByteOrder.LITTLE_ENDIAN).int
    check(bytes.size >= expectedSize) {
      "Compiling JS failed: Buffer is smaller than the size stated in the file header. Expected at least $expectedSize bytes but got ${bytes.size} bytes"
    }
    println("APP_STARTED update=${launch.launchedUpdate!!.sequence} bytes=${bytes.size}")
    return launch
  }
}

fun main(args: Array<String>) = runBlocking {
  val root = File(args[0])
  val complete = File(args[1]).readBytes()
  val scenario = args[2]
  when (scenario) {
    "W-1-fallback" -> {
      for (embeddedOnly in listOf(false, true)) {
        val installation = Installation(File(root, "fallback-$embeddedOnly"), complete, embeddedOnly)
        check(installation.start(this).launchedUpdate == installation.previous)
        check(installation.latest.status == UpdateStatus.PENDING)
        check(installation.latest.failedLaunchCount == 0)
        check(!File(installation.root, "latest").exists())
        // Starting again must keep the valid previous bundle, without purging its cache.
        val before = File(installation.root, "previous").lastModified()
        check(installation.start(this).launchedUpdate == installation.previous)
        check(File(installation.root, "previous").lastModified() == before)
      }
    }
    "W-1-retry" -> {
      var installation = Installation(File(root, "retry"), complete)
      check(installation.start(this).launchedUpdate == installation.previous)
      var downloads = 0
      fun loader(payload: ByteArray) = object : Loader(context, config, logger, installation.database, installation.root, LoaderFiles()) {
        override suspend fun loadRemoteUpdate(database: UpdatesDatabase, configuration: UpdatesConfiguration) =
          UpdateResponse(ManifestPart(Update(installation.latest, listOf(installation.latestAsset))))
        override suspend fun loadAsset(assetEntity: AssetEntity, updatesDirectory: File, configuration: UpdatesConfiguration, requestedUpdate: UpdateEntity?, embeddedUpdate: UpdateEntity?): FileDownloader.AssetDownloadResult {
          downloads++
          val file = File(updatesDirectory, assetEntity.relativePath!!)
          assetEntity.hash = UpdatesUtils.verifySHA256AndWriteToFile(payload.inputStream(), file, assetEntity.expectedHash)
          return FileDownloader.AssetDownloadResult(assetEntity, true)
        }
      }
      // Another interrupted check must not make the partial bundle launchable.
      try {
        loader(complete.copyOf(5390336)).load { Loader.OnUpdateResponseLoadedResult(true) }
        error("Truncated download was accepted")
      } catch (_: IOException) {}
      check(installation.latest.status == UpdateStatus.PENDING)
      check(installation.start(this).launchedUpdate == installation.previous)
      // A later successful check uses the real Loader PENDING -> READY path.
      loader(complete).load { Loader.OnUpdateResponseLoadedResult(true) }
      check(downloads == 2)
      check(installation.latest.status == UpdateStatus.READY)
      check(installation.start(this).launchedUpdate == installation.latest)
      check(File(installation.root, "latest").readBytes().contentEquals(complete))
      // Also cover death during file publication, before READY is committed,
      // and a fetch racing with a damaged READY cache before the next launch.
      for (status in listOf(UpdateStatus.PENDING, UpdateStatus.READY)) {
        installation = Installation(File(root, "retry-existing-$status"), complete)
        installation.latest.status = status
        downloads = 0
        try {
          loader(complete.copyOf(5390336)).load { Loader.OnUpdateResponseLoadedResult(true) }
          error("Existing partial cache was accepted as a finished download")
        } catch (_: IOException) {}
        check(installation.latest.status == UpdateStatus.PENDING)
        check(installation.start(this).launchedUpdate == installation.previous)
        loader(complete).load { Loader.OnUpdateResponseLoadedResult(true) }
        check(downloads == 2)
        check(installation.start(this).launchedUpdate == installation.latest)
      }
    }
    else -> error("Unknown scenario $scenario")
  }
  println("PASS $scenario")
}
