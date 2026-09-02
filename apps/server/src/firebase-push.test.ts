import { describe, expect, it, vi } from 'vitest';
import type { Credential, ServiceAccount } from 'firebase-admin/app';
import { firebaseAppOptions, requirePushDeliveryCredentials } from './firebase-push.js';

const fakeCredential = {} as Credential;

describe('Firebase push credentials', () => {
  it('uses an inline service account with cert and its project id', () => {
    const applicationDefault = vi.fn(() => fakeCredential);
    const cert = vi.fn((_serviceAccount: ServiceAccount) => fakeCredential);
    const serviceAccount = {
      project_id: 'firebase-project',
      client_email: 'firebase@example.com',
      private_key: 'secret-key',
    };

    const options = firebaseAppOptions(
      { GOOGLE_APPLICATION_CREDENTIALS_JSON: JSON.stringify(serviceAccount) },
      { applicationDefault, cert },
    );

    expect(cert).toHaveBeenCalledWith(serviceAccount);
    expect(applicationDefault).not.toHaveBeenCalled();
    expect(options).toEqual({ credential: fakeCredential, projectId: 'firebase-project' });
  });

  it('lets GOOGLE_CLOUD_PROJECT override the inline project id', () => {
    const cert = vi.fn((_serviceAccount: ServiceAccount) => fakeCredential);

    const options = firebaseAppOptions(
      {
        GOOGLE_APPLICATION_CREDENTIALS_JSON: JSON.stringify({ project_id: 'inline-project' }),
        GOOGLE_CLOUD_PROJECT: 'override-project',
      },
      { applicationDefault: vi.fn(() => fakeCredential), cert },
    );

    expect(options.projectId).toBe('override-project');
  });

  it.each([
    ['invalid JSON', '{'],
    ['a non-object value', 'null'],
  ])('rejects inline credentials containing %s', (_description, value) => {
    expect(() => firebaseAppOptions({ GOOGLE_APPLICATION_CREDENTIALS_JSON: value })).toThrow(
      `GOOGLE_APPLICATION_CREDENTIALS_JSON must contain ${
        value === '{' ? 'valid JSON' : 'a service-account object'
      }`,
    );
  });

  it('falls back to Application Default Credentials without inline JSON', () => {
    const applicationDefault = vi.fn(() => fakeCredential);
    const cert = vi.fn((_serviceAccount: ServiceAccount) => fakeCredential);

    const options = firebaseAppOptions({}, { applicationDefault, cert });

    expect(applicationDefault).toHaveBeenCalledOnce();
    expect(cert).not.toHaveBeenCalled();
    expect(options).toEqual({ credential: fakeCredential });
  });

  it('fails startup explicitly when Application Default Credentials are unavailable', async () => {
    const credential = {
      getAccessToken: vi.fn().mockRejectedValue(new Error('Could not load the default credentials')),
    } as unknown as Credential;

    await expect(requirePushDeliveryCredentials(credential)).rejects.toThrow(
      'PUSH_DELIVERY_ENABLED=true but Firebase credentials are unusable; set GOOGLE_APPLICATION_CREDENTIALS_JSON or configure Application Default Credentials: Could not load the default credentials',
    );
  });

  it('accepts credentials that can mint an access token', async () => {
    const credential = {
      getAccessToken: vi.fn().mockResolvedValue({ access_token: 'token', expires_in: 3600 }),
    } as unknown as Credential;

    await expect(requirePushDeliveryCredentials(credential)).resolves.toBeUndefined();
  });
});
