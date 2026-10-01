import { describe, expect, it, vi } from 'vitest';

// Real uploader and real phone transport; only the network, file read and
// native modules are stubbed.
const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  readFileBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
}));

vi.mock('expo-crypto', () => ({
  getRandomBytes: (length: number) => new Uint8Array(length).fill(7),
}));
vi.mock('expo-image-manipulator', () => ({ manipulateAsync: vi.fn(), SaveFormat: {} }));
vi.mock('expo-file-system/legacy', () => ({}));
vi.mock('@/utils/readFileBytes', () => ({ readFileBytes: mocks.readFileBytes }));
vi.mock('@/buzz/runtime-config', () => ({
  getBuzzRuntimeConfig: () => ({ monolithUrl: 'https://server.example' }),
}));
vi.mock('@/auth/monolith-session', () => ({ monolithSession: { fetch: mocks.fetch } }));
vi.mock('@/sync/transport/live-connection', () => ({ sharedLiveConnection: vi.fn() }));

import { createChatAttachmentUploader, type PickedChatAttachment } from './chat-attachment';
import { BuzzRigTransport } from '@/sync/transport';

const MEDIA_URL = 'https://server.example/v1/phone/media';
const SEND_URL = 'https://server.example/v1/phone/operations/sendRoomMessage';
const stored = {
  url: 'https://server.example/v1/media/0b6a1f6e-4c39-4f7e-9d1e-5d3c1b2a9f00',
  mimeType: 'application/pdf',
  size: 3,
  sha256: 'a'.repeat(64),
};

const report: PickedChatAttachment = {
  uri: 'file:///cache/report.pdf',
  name: 'report.pdf',
  mimeType: 'application/pdf',
  size: 3,
  source: 'file',
};
const transport = () =>
  new BuzzRigTransport({ publicKey: 'viewer', secretKey: new Uint8Array(32) } as never);
const sentAttachments = () =>
  (
    JSON.parse(String(mocks.fetch.mock.calls.find(([url]) => url === SEND_URL)?.[1].body)) as {
      attachments: unknown[];
    }
  ).attachments;
const mediaPosts = () => mocks.fetch.mock.calls.filter(([url]) => url === MEDIA_URL).length;

describe('Send while a staged file is still uploading', () => {
  it('uploads a staged file through phone media once and sends it as an attachment', async () => {
    mocks.fetch.mockReset();
    mocks.fetch.mockImplementation(async (url: string, init: RequestInit) => {
      if (url === MEDIA_URL) return new Response(JSON.stringify(stored), { status: 201 });
      const input = JSON.parse(String(init.body)) as { messageId: string };
      return new Response(JSON.stringify({ messageId: input.messageId }), { status: 200 });
    });
    const phone = transport();
    const uploader = createChatAttachmentUploader();

    uploader.start(await phone.ensureClient(), [report]);
    await vi.waitFor(() => expect(mediaPosts()).toBe(1));
    console.log('staged report.pdf; POST /v1/phone/media before Send');

    const attachments = await uploader.uploadAll(await phone.ensureClient(), [report]);
    await phone.publishPreparedMessage(
      await phone.composeMessage({ sessionId: 'room', text: '', attachments }),
    );
    console.log(
      `Send result: sent with ${sentAttachments().length} attachment after ${mediaPosts()} media POST`,
    );
    expect(mediaPosts()).toBe(1);
    expect(sentAttachments()).toEqual([
      expect.objectContaining({ name: 'report.pdf', url: stored.url }),
    ]);
  });

  it('retries a background upload that fails in flight and sends the file', async () => {
    let failBackgroundUpload!: () => void;
    mocks.fetch.mockReset();
    mocks.fetch.mockImplementation(async (url: string, init: RequestInit) => {
      if (url === MEDIA_URL && !failBackgroundUpload)
        return new Promise<Response>((resolve) => {
          failBackgroundUpload = () => resolve(new Response('unavailable', { status: 503 }));
        });
      if (url === MEDIA_URL) return new Response(JSON.stringify(stored), { status: 201 });
      if (url === SEND_URL) {
        const input = JSON.parse(String(init.body)) as { messageId: string };
        return new Response(JSON.stringify({ messageId: input.messageId }), { status: 200 });
      }
      throw new Error(`unexpected request ${url}`);
    });
    const phone = transport();
    const uploader = createChatAttachmentUploader();

    // The chat surface's staging effect.
    uploader.start(await phone.ensureClient(), [report]);
    await vi.waitFor(() => expect(failBackgroundUpload).toBeTypeOf('function'));
    console.log('staged report.pdf; POST /v1/phone/media in flight');

    // The chat surface's Send, pressed before that upload finishes.
    const sending = uploader.uploadAll(await phone.ensureClient(), [report]);
    failBackgroundUpload();
    const attachments = await sending.catch((error: Error) => {
      console.log(`Send result: Message not sent (${error.message})`);
      throw error;
    });
    await phone.publishPreparedMessage(
      await phone.composeMessage({ sessionId: 'room', text: '', attachments }),
    );
    console.log(
      `Send result: sent with ${sentAttachments().length} attachment after ${mediaPosts()} media POSTs`,
    );
    expect(mediaPosts()).toBe(2);
    expect(sentAttachments()).toEqual([
      expect.objectContaining({ name: 'report.pdf', url: stored.url }),
    ]);
  });
});
