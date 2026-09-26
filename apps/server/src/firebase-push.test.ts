import { describe, expect, it, vi } from 'vitest';
import type { Credential, ServiceAccount } from 'firebase-admin/app';
import {
  firebaseAppOptions,
  firebasePushMessage,
  requirePushDeliveryCredentials,
} from './firebase-push.js';

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
      getAccessToken: vi
        .fn()
        .mockRejectedValue(new Error('Could not load the default credentials')),
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

describe('Firebase push routing payload', () => {
  it.each([
    ['Room mention', 'room-1', 'room-1', undefined, 'message'],
    ['corner mention', 'parent-1', 'corner-1', 'corner-1', 'message'],
    ['corner opened', 'parent-1', 'corner-1', 'corner-1', 'corner'],
    ['corner closed', 'parent-1', 'corner-1', 'corner-1', 'corner'],
    ['DM', 'dm-1', 'dm-1', undefined, 'message'],
    ['release notice in system DM', 'system-dm-1', 'system-dm-1', undefined, 'message'],
  ])('carries the complete %s destination', (_kind, roomId, channelId, cornerId, target) => {
    const payload = firebasePushMessage('device-token', {
      messageId: 'message-1',
      workspaceId: 'workspace-1',
      roomId,
      channelId,
      ...(cornerId ? { cornerId } : {}),
      target: target as 'message' | 'corner',
      type: 'message',
      text: 'routing payload',
    });
    expect(payload.data).toEqual({
      type: 'channel-activity',
      target,
      workspaceId: 'workspace-1',
      roomId,
      threadId: roomId,
      channelId,
      ...(cornerId ? { cornerId } : {}),
      messageId: 'message-1',
      title: 'Beeline',
      message: 'routing payload',
      tag: 'message-1',
    });
    expect(payload).not.toHaveProperty('notification');
    expect(payload.android).toEqual({ priority: 'high' });
    expect(payload.apns).toEqual({ payload: { aps: { sound: 'default', threadId: roomId } } });
    expect(payload.android).not.toHaveProperty('collapseKey');
  });

  it('carries a workspace join to its exact Workspace and Room', () => {
    expect(
      firebasePushMessage('device-token', {
        messageId: 'workspace-join:notification-id',
        workspaceId: 'workspace-default',
        roomId: 'room-welcome',
        type: 'workspace-join',
        text: 'alice joined Beeline',
      }),
    ).toMatchObject({
      token: 'device-token',
      android: { priority: 'high' },
      apns: { payload: { aps: { sound: 'default', threadId: 'room-welcome' } } },
      data: {
        type: 'workspace-join',
        target: 'message',
        workspaceId: 'workspace-default',
        roomId: 'room-welcome',
        channelId: 'room-welcome',
        threadId: 'room-welcome',
      },
    });
  });

  it('routes a Workspace-only join to the exact Workspace without inventing a Room', () => {
    expect(
      firebasePushMessage('device-token', {
        messageId: 'workspace-join:notification-id',
        workspaceId: 'workspace-default',
        type: 'workspace-join',
        text: 'alice joined Beeline',
      }).data,
    ).toEqual({
      type: 'workspace-join',
      target: 'workspace',
      workspaceId: 'workspace-default',
      title: 'Beeline',
      message: 'alice joined Beeline',
      tag: 'workspace-join:notification-id',
    });
  });
});

describe('Firebase push inline actions', () => {
  const base = {
    messageId: 'message-1',
    workspaceId: 'workspace-1',
    roomId: 'dm-1',
    channelId: 'dm-1',
    target: 'message' as const,
    type: 'message' as const,
  };

  it('names the grant category and the one pending grant it answers', () => {
    const payload = firebasePushMessage('device-token', {
      ...base,
      text: '@wren asked @charles for host api.stripe.com · checking the invoice webhook',
      action: {
        kind: 'grant',
        grantId: 'grant-1',
        grantKind: 'host',
        grantTarget: 'api.stripe.com',
        agentName: 'wren',
      },
    });
    expect(payload.data).toMatchObject({
      categoryId: 'beeline-grant',
      grantId: 'grant-1',
      grantKind: 'host',
      grantTarget: 'api.stripe.com',
      agentName: 'wren',
      messageId: 'message-1',
      message: '@wren asked @charles for host api.stripe.com · checking the invoice webhook',
    });
  });

  it('names the reply category and who is being answered', () => {
    const payload = firebasePushMessage('device-token', {
      ...base,
      text: 'Maya: @charles can you look?',
      action: { kind: 'reply', authorName: 'Maya' },
    });
    expect(payload.data).toMatchObject({
      categoryId: 'beeline-reply',
      authorName: 'Maya',
      channelId: 'dm-1',
      messageId: 'message-1',
    });
  });

  it('adds no category to a push without an action', () => {
    expect(firebasePushMessage('device-token', { ...base, text: 'hello' }).data).not.toHaveProperty(
      'categoryId',
    );
  });
});
