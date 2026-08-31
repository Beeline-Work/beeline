import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import type { PushSender } from './background.js';

export function createFirebasePushSender(projectId?: string): PushSender {
  const app =
    getApps()[0] ??
    initializeApp({ credential: applicationDefault(), ...(projectId ? { projectId } : {}) });
  const messaging = getMessaging(app);
  return {
    async send(token, message) {
      await messaging.send({
        token,
        notification: { title: 'Beeline', body: message.text.slice(0, 200) },
        data: { messageId: message.messageId, roomId: message.roomId },
        apns: { payload: { aps: { sound: 'default' } } },
      });
    },
  };
}
