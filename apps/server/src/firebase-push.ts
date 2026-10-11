import {
  applicationDefault,
  cert,
  getApps,
  initializeApp,
  type AppOptions,
  type Credential,
  type ServiceAccount,
} from 'firebase-admin/app';
import { getMessaging, type Message } from 'firebase-admin/messaging';
import { pushActionData, readClearPushData } from '@beeline/api-contract/phone';
import type { PushSender, ReadClearCursor } from './background.js';

export type PushDeliveryMessage = Parameters<PushSender['send']>[1];

interface FirebaseCredentialEnvironment {
  GOOGLE_APPLICATION_CREDENTIALS_JSON?: string;
  GOOGLE_CLOUD_PROJECT?: string;
}

interface CredentialFactories {
  applicationDefault(): Credential;
  cert(serviceAccount: ServiceAccount): Credential;
}

export function firebaseAppOptions(
  environment: FirebaseCredentialEnvironment,
  factories: CredentialFactories = { applicationDefault, cert },
): AppOptions {
  const inlineJson = environment.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!inlineJson) {
    return {
      credential: factories.applicationDefault(),
      ...(environment.GOOGLE_CLOUD_PROJECT ? { projectId: environment.GOOGLE_CLOUD_PROJECT } : {}),
    };
  }

  let serviceAccount: unknown;
  try {
    serviceAccount = JSON.parse(inlineJson);
  } catch {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS_JSON must contain valid JSON');
  }
  if (!serviceAccount || typeof serviceAccount !== 'object' || Array.isArray(serviceAccount)) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS_JSON must contain a service-account object');
  }
  const inlineProjectId = (serviceAccount as { project_id?: unknown }).project_id;
  const projectId =
    environment.GOOGLE_CLOUD_PROJECT ??
    (typeof inlineProjectId === 'string' && inlineProjectId ? inlineProjectId : undefined);
  return {
    credential: factories.cert(serviceAccount as ServiceAccount),
    ...(projectId ? { projectId } : {}),
  };
}

export async function requirePushDeliveryCredentials(credential: Credential): Promise<void> {
  try {
    await credential.getAccessToken();
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : '';
    throw new Error(
      `PUSH_DELIVERY_ENABLED=true but Firebase credentials are unusable; set GOOGLE_APPLICATION_CREDENTIALS_JSON or configure Application Default Credentials${detail}`,
      { cause: error },
    );
  }
}

/** Serialize every monolith push into the routing contract consumed by the phone. */
export function pushMessageData(message: PushDeliveryMessage): Record<string, string> {
  let data: Record<string, string>;
  if (message.type === 'test') data = { type: 'test' };
  else if (message.type === 'workspace-join' && !message.roomId)
    data = {
      type: 'workspace-join',
      target: 'workspace',
      workspaceId: message.workspaceId,
    };
  else {
    const roomId = message.roomId;
    if (!roomId) throw new Error('routable push is missing its Room');
    data = {
      type: message.type === 'workspace-join' ? 'workspace-join' : 'channel-activity',
      target: message.type === 'message' ? message.target : 'message',
      workspaceId: message.workspaceId,
      roomId,
      threadId: roomId,
      channelId: message.type === 'message' ? message.channelId : roomId,
      ...(message.type === 'message' && message.cornerId ? { cornerId: message.cornerId } : {}),
      ...(message.type === 'message' ? { messageId: message.messageId } : {}),
      ...(message.type === 'message' ? pushActionData(message.action) : {}),
      ...(message.collapseId ? { collapseId: message.collapseId } : {}),
    };
  }
  return data;
}

/**
 * The words a notification shows. A chat line is cut to a preview under its
 * conversation's in-app title, or the app's name when it has none. A permission ask is sent whole and without the "Beeline" title,
 * so the ask itself takes the first line; the phone already names the app.
 */
export function pushAlert(message: PushDeliveryMessage): { title?: string; body: string } {
  if (message.permission) return { body: message.text };
  const title = (message.type === 'message' && message.title) || 'Beeline';
  return { title, body: message.text.slice(0, 200) };
}

/**
 * Android pushes are data-only: expo-notifications draws the notification
 * itself (title `title`, body `message`, identifier `tag`), which is the only
 * way it can attach the inline action buttons named by `categoryId`. An FCM
 * `notification` block would be drawn by the system tray with no buttons.
 * Activity reuses a Room slot; the tap router deduplicates by payload message
 * id so replacements remain actionable.
 */
export function firebasePushMessage(token: string, message: PushDeliveryMessage): Message {
  const data = pushMessageData(message);
  const alert = pushAlert(message);
  return {
    token,
    data: {
      ...data,
      ...(alert.title ? { title: alert.title } : {}),
      message: alert.body,
      tag: message.collapseId ?? message.messageId,
    },
    android: { priority: 'high' },
    apns: {
      payload: {
        aps: { sound: 'default', ...(data.roomId ? { threadId: data.roomId } : {}) },
      },
    },
  };
}

/** FCM rejects a message whose data keys and values exceed this many bytes. */
export const FCM_MAX_DATA_BYTES = 4096;

/**
 * The longest prefix of these reads whose read-clear payload `fits`; the
 * caller leaves the rest for a later push. A first read too large on its own
 * keeps its cursor and as many of its newest read ids as fit.
 */
export function readClearBatch(
  reads: readonly ReadClearCursor[],
  fits: (batch: readonly ReadClearCursor[]) => boolean,
): ReadClearCursor[] {
  const batch: ReadClearCursor[] = [];
  for (const read of reads) {
    if (!fits([...batch, read])) break;
    batch.push(read);
  }
  if (batch.length > 0 || reads.length === 0) return batch;
  const first = { ...reads[0]!, readMessageIds: [...reads[0]!.readMessageIds] };
  while (first.readMessageIds.length > 0 && !fits([first])) first.readMessageIds.pop();
  return [first];
}

/**
 * Expo hands an Android data message's `body` to the background task as
 * `dataString`, the same JSON shape iOS delivers, so one parser reads both.
 */
function firebaseReadClearData(reads: readonly ReadClearCursor[]): Record<string, string> {
  return { body: JSON.stringify(readClearPushData(reads)) };
}

export function firebaseReadClearBatch(reads: readonly ReadClearCursor[]): ReadClearCursor[] {
  return readClearBatch(reads, (batch) =>
    Object.entries(firebaseReadClearData(batch)).reduce(
      (bytes, [key, value]) => bytes + Buffer.byteLength(key) + Buffer.byteLength(value), 0,
    ) <= FCM_MAX_DATA_BYTES);
}

/**
 * A data-only Android push that wakes the app's background task to clear
 * these conversations from the shade. It has no title or text, so Expo draws
 * nothing. High priority, so a dozing phone still runs the task.
 */
export function firebaseReadClearMessage(token: string, reads: readonly ReadClearCursor[]): Message {
  return { token, data: firebaseReadClearData(reads), android: { priority: 'high' } };
}

export async function createFirebasePushSender(
  environment: FirebaseCredentialEnvironment = process.env,
): Promise<PushSender> {
  const options = firebaseAppOptions(environment);
  if (options.credential) await requirePushDeliveryCredentials(options.credential);
  const app = getApps()[0] ?? initializeApp(options);
  const messaging = getMessaging(app);
  return {
    async send(token, message) {
      await messaging.send(firebasePushMessage(token, message));
    },
    async clearRead(token, reads) {
      await messaging.send(firebaseReadClearMessage(token, reads));
    },
  };
}
