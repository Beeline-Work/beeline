package app.usebeeline.httppool

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class AndroidHttpPoolModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AndroidHttpPool")
    Function("evictIdleConnections") { HttpPool.evictIdleSoon() }
  }
}
