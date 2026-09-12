package app.usebeeline.push

import android.app.Notification as AndroidNotification
import android.app.NotificationManager
import android.content.Context
import android.os.Bundle
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import expo.modules.notifications.notifications.model.Notification
import expo.modules.notifications.notifications.model.NotificationBehaviorRecord
import expo.modules.notifications.notifications.model.triggers.FirebaseNotificationTrigger
import expo.modules.notifications.notifications.presentation.builders.ExpoNotificationBuilder
import expo.modules.notifications.service.NotificationsService
import expo.modules.notifications.service.delegates.ExpoPresentationDelegate
import expo.modules.notifications.service.interfaces.PresentationDelegate
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class RoomNotificationsService : NotificationsService() {
  override fun getPresentationDelegate(context: Context): PresentationDelegate = RoomPresentationDelegate(context)
}

private class RoomPresentationDelegate(context: Context) : ExpoPresentationDelegate(context) {
  companion object {
    // Presentation and dismissal share the same lock, including across receiver instances.
    private val groupLock = Any()
    private const val SUMMARY_PREFIX = "beeline-room-summary:"
  }

  override fun presentNotification(notification: Notification, behavior: NotificationBehaviorRecord?) {
    val request = notification.notificationRequest
    val data = (request.trigger as? FirebaseNotificationTrigger)?.remoteMessage?.data
    val roomId = data?.get("roomId")?.takeIf { it.isNotBlank() }
    if (roomId == null || behavior?.shouldPresentAlert == false) {
      super.presentNotification(notification, behavior)
      return
    }
    val group = data?.get("threadId")?.takeIf { it.isNotBlank() } ?: roomId
    CoroutineScope(Dispatchers.IO).launch {
      val built = createNotification(notification, behavior)
      val child = AndroidNotification.Builder.recoverBuilder(context, built)
        .setGroup(group).setGroupAlertBehavior(AndroidNotification.GROUP_ALERT_CHILDREN).build()
      synchronized(groupLock) {
        val manager = NotificationManagerCompat.from(context)
        manager.notify(request.identifier, 0, child)
        val children = activeChildren(group)
        val extras = Bundle().apply {
          putString("type", "channel-activity")
          putString("target", "message")
          putString("roomId", roomId)
          putString("channelId", roomId)
          putString("threadId", group)
          putString("workspaceId", data?.get("workspaceId"))
          putBoolean("groupSummary", true)
        }
        // Summary opens the stack. Only children have message tap destinations.
        val summary = AndroidNotification.Builder.recoverBuilder(context, child)
          .setExtras(extras).setContentIntent(null).setDeleteIntent(null)
          .setContentTitle("Beeline").setContentText("${children.size} new messages")
          .setGroupSummary(true).setOnlyAlertOnce(true)
          .setGroupAlertBehavior(AndroidNotification.GROUP_ALERT_CHILDREN).build()
        summary.extras.remove(ExpoNotificationBuilder.EXTRAS_MARSHALLED_NOTIFICATION_REQUEST_KEY)
        manager.notify(SUMMARY_PREFIX + group, 0, summary)
      }
    }
  }

  private fun activeChildren(group: String) =
    (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).activeNotifications
      .filter { it.notification.group == group && !NotificationCompat.isGroupSummary(it.notification) }

  override fun getAllPresentedNotifications(): Collection<Notification> = synchronized(groupLock) {
    cleanSummaries()
    super.getAllPresentedNotifications()
  }

  override fun dismissNotifications(identifiers: Collection<String>) {
    synchronized(groupLock) {
      super.dismissNotifications(identifiers)
      cleanSummaries()
    }
  }

  private fun cleanSummaries() {
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    for (summary in manager.activeNotifications.filter { it.tag?.startsWith(SUMMARY_PREFIX) == true }) {
      val children = activeChildren(summary.notification.group)
      if (children.isEmpty()) {
        manager.cancel(summary.tag, summary.id)
      } else {
        manager.notify(summary.tag, summary.id,
          AndroidNotification.Builder.recoverBuilder(context, summary.notification)
            .setContentText("${children.size} new messages").setOnlyAlertOnce(true).build())
      }
    }
  }
}
