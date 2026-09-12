package app.usebeeline.push

import android.content.Intent
import com.google.firebase.messaging.RemoteMessage
import expo.modules.notifications.service.ExpoFirebaseMessagingService

/** Keep FCM's notification+data pushes on Expo's presentation path in background too. */
class RoomFirebaseMessagingService : ExpoFirebaseMessagingService() {
  override fun handleIntent(intent: Intent) {
    val extras = intent.extras
    if (intent.action == "com.google.android.c2dm.intent.RECEIVE" &&
      (extras?.getString("message_type") ?: "gcm") == "gcm" &&
      !extras?.getString("roomId").isNullOrBlank() &&
      extras?.getString("type") in listOf("channel-activity", "workspace-join")) {
      // Otherwise Firebase auto-displays by tag before onMessageReceived, losing
      // the individual children and Expo's serialized request needed on dismiss.
      onMessageReceived(RemoteMessage(extras!!))
    } else {
      super.handleIntent(intent)
    }
  }
}
