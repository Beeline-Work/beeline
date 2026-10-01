import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  readFileBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
}));

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
}));
vi.mock('expo-crypto', () => ({
  getRandomBytes: (length: number) => new Uint8Array(length).fill(7),
}));
vi.mock('expo-image-manipulator', () => ({ manipulateAsync: vi.fn(), SaveFormat: {} }));
vi.mock('expo-file-system/legacy', () => ({
  writeAsStringAsync: vi.fn(),
  EncodingType: { Base64: 'base64' },
  cacheDirectory: 'file:///cache/',
}));
vi.mock('@/utils/readFileBytes', () => ({ readFileBytes: mocks.readFileBytes }));
vi.mock('@/buzz/runtime-config', () => ({
  getBuzzRuntimeConfig: () => ({ monolithEnabled: true, monolithUrl: 'https://server.example' }),
}));
vi.mock('@/auth/monolith-session', () => ({
  monolithSession: { fetch: mocks.fetch, authorization: vi.fn(async () => 'phone-session') },
}));
vi.mock('@/auth/buzz-identity-storage', () => ({
  loadBuzzIdentity: vi.fn(async () => ({ publicKey: 'viewer', secretKey: new Uint8Array() })),
}));

import { createChatAttachmentUploader, type PickedChatAttachment } from './chat-attachment';
import { chatUploadTransport } from './chat-upload-transport';

const file: PickedChatAttachment = {
  uri: 'file:///cache/report.pdf',
  name: 'report.pdf',
  mimeType: 'application/pdf',
  size: 3,
  source: 'file',
};

describe('composer file upload through the phone transport', () => {
  it('uploads on staging, reuses the in-flight upload on Send, and retries after failure', async () => {
    const media = {
      url: 'https://server.example/v1/media/report',
      mimeType: 'application/pdf',
      size: 3,
      sha256: 'a'.repeat(64),
    };
    let finishUpload!: (response: Response) => void;
    const inFlight = new Promise<Response>((resolve) => { finishUpload = resolve; });
    mocks.fetch.mockReset();
    mocks.fetch.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.endsWith('/v1/phone/media')) return inFlight;
      const input = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ messageId: input.messageId }), { status: 200 });
    });
    const adopt = vi.fn();
    const transport = await chatUploadTransport(null, adopt);
    expect(adopt).toHaveBeenCalledWith(transport);
    expect(await chatUploadTransport(transport, adopt)).toBe(transport);
    expect(adopt).toHaveBeenCalledTimes(1);
    const uploader = createChatAttachmentUploader();
    uploader.start(transport, [file]);
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledWith(
      'https://server.example/v1/phone/media',
      expect.objectContaining({ method: 'POST', body: new Uint8Array([1, 2, 3]) }),
    ));
    console.log('staged report.pdf; phone media upload started before Send');

    const sending = uploader.uploadAll(transport, [file]);
    finishUpload(new Response(JSON.stringify(media), { status: 201 }));
    const attachments = await sending;
    const event = await transport.composeMessage({ sessionId: 'room-id', text: '', attachments });
    await transport.publishPreparedMessage(event);
    expect(attachments).toEqual([expect.objectContaining({ name: 'report.pdf', url: media.url })]);
    expect(mocks.fetch.mock.calls.filter(([url]) => url.endsWith('/v1/phone/media'))).toHaveLength(1);
    expect(mocks.fetch).toHaveBeenCalledWith(
      'https://server.example/v1/phone/operations/sendRoomMessage',
      expect.objectContaining({ method: 'POST' }),
    );
    const messageCall = mocks.fetch.mock.calls.find(([url]) =>
      url.endsWith('/v1/phone/operations/sendRoomMessage'));
    expect(JSON.parse(String(messageCall?.[1].body)).attachments).toEqual(attachments);
    console.log('Send published report.pdf as an attachment with one media upload');

    const failedFile = { ...file };
    mocks.fetch.mockResolvedValueOnce(new Response('upload failed', { status: 503 }));
    await expect(uploader.uploadAll(transport, [failedFile])).rejects.toThrow('Media upload failed (503)');
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify(media), { status: 201 }));
    await expect(uploader.uploadAll(transport, [failedFile])).resolves.toEqual([
      expect.objectContaining({ name: 'report.pdf', url: media.url }),
    ]);
    console.log('failed upload retried successfully on Send');
  });
});
