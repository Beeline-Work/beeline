package app.usebeeline.httppool

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri

/** Installs the HTTP client factory before React Native creates its networking module. */
class HttpPoolProvider : ContentProvider() {
  override fun onCreate(): Boolean {
    context?.let { runCatching { HttpPool.install(it) } }
    return true
  }
  override fun query(uri: Uri, projection: Array<out String>?, selection: String?, args: Array<out String>?, order: String?): Cursor? = null
  override fun getType(uri: Uri): String? = null
  override fun insert(uri: Uri, values: ContentValues?): Uri? = null
  override fun delete(uri: Uri, selection: String?, args: Array<out String>?): Int = 0
  override fun update(uri: Uri, values: ContentValues?, selection: String?, args: Array<out String>?): Int = 0
}
