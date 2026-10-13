package app.usebeeline.crashtrace

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class AndroidCrashTraceModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AndroidCrashTrace")
    AsyncFunction("getPending") { CrashTrace.pending()?.toString() }
    AsyncFunction("acknowledge") { id: String -> CrashTrace.acknowledge(id) }
    Function("setReleaseContext") { releaseSha: String, runtimeVersion: String, updateId: String ->
      CrashTrace.setReleaseContext(releaseSha, runtimeVersion, updateId)
    }
  }
}
