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
import type { PushSender } from './background.js';

type PushDeliveryMessage = Parameters<PushSender['send']>[1];

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
export function firebasePushMessage(token: string, message: PushDeliveryMessage): Message {
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
    };
  }
  return {
    token,
    notification: { title: 'Beeline', body: message.text.slice(0, 200) },
    data,
    ...(data.roomId ? { android: { notification: { tag: data.roomId } } } : {}),
    apns: {
      payload: {
        aps: { sound: 'default', ...(data.roomId ? { threadId: data.roomId } : {}) },
      },
    },
  };
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
  };
}
