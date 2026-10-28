package app.usebeeline.googlepicker

import androidx.core.content.ContextCompat
import androidx.credentials.CredentialManager
import androidx.credentials.CredentialManagerCallback
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class GoogleAccountPickerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("GoogleAccountPicker")
    AsyncFunction("signIn") { serverClientId: String, nonce: String, promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.reject("GOOGLE_UNAVAILABLE", "Open the app to sign in with Google", null)
        return@AsyncFunction
      }
      val option = GetSignInWithGoogleOption.Builder(serverClientId).setNonce(nonce).build()
      val request = GetCredentialRequest.Builder().addCredentialOption(option).build()
      CredentialManager.create(activity).getCredentialAsync(activity, request, null,
        ContextCompat.getMainExecutor(activity),
        object : CredentialManagerCallback<GetCredentialResponse, GetCredentialException> {
          override fun onResult(result: GetCredentialResponse) {
            try {
              val credential = result.credential
              if (credential !is CustomCredential ||
                  credential.type != GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
                promise.reject("GOOGLE_INVALID_CREDENTIAL", "Google returned an unsupported credential", null)
                return
              }
              promise.resolve(GoogleIdTokenCredential.createFrom(credential.data).idToken)
            } catch (_: Exception) {
              promise.reject("GOOGLE_INVALID_CREDENTIAL", "Google sign-in could not finish", null)
            }
          }
          override fun onError(error: GetCredentialException) {
            val cancelled = error is GetCredentialCancellationException
            promise.reject(if (cancelled) "GOOGLE_CANCELLED" else "GOOGLE_UNAVAILABLE",
              if (cancelled) "Google sign-in was canceled" else "Google sign-in could not finish. Try again.", null)
          }
        })
    }
  }
}
