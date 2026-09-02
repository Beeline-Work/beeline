import {
  applicationDefault,
  cert,
  getApps,
  initializeApp,
  type AppOptions,
  type Credential,
  type ServiceAccount,
} from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import type { PushSender } from './background.js';

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
      ...(environment.GOOGLE_CLOUD_PROJECT
        ? { projectId: environment.GOOGLE_CLOUD_PROJECT }
        : {}),
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

export async function createFirebasePushSender(
  environment: FirebaseCredentialEnvironment = process.env,
): Promise<PushSender> {
  const options = firebaseAppOptions(environment);
  if (options.credential) await requirePushDeliveryCredentials(options.credential);
  const app = getApps()[0] ?? initializeApp(options);
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
