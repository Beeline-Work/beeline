import * as React from 'react';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Reproduction upload-1: the real phone transport, uploader and composer row,
// talking to a local HTTP server over a real socket. The surface below wires
// them the way _chat-surface.tsx does.
const server = vi.hoisted(() => ({ url: '' }));
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Text: host('Text'),
    View: host('View'),
    TextInput: host('TextInput'),
    TouchableOpacity: host('TouchableOpacity'),
    Pressable: host('Pressable'),
    Platform: { OS: 'android', select: (c: any) => c.android ?? c.default },
  };
});
vi.mock('expo-haptics', () => ({ impactAsync: vi.fn(), ImpactFeedbackStyle: {} }));
vi.mock('@/utils/responsive', () => ({ useIsDesktop: () => false }));
vi.mock('react-native-svg', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return { default: host('RNSVG'), Svg: host('RNSVG'), Line: host('RNSVGLine') };
});
vi.mock('./HullDialog', () => ({ HullDialog: () => null }));
vi.mock('@/components/buzz/HullDialog', () => ({ HullDialog: () => null }));
vi.mock('expo-crypto', () => ({ getRandomBytes: (n: number) => new Uint8Array(n).fill(7) }));
vi.mock('expo-image-manipulator', () => ({ manipulateAsync: vi.fn(), SaveFormat: {} }));
vi.mock('expo-file-system/legacy', () => ({}));
vi.mock('@/utils/readFileBytes', () => ({
  readFileBytes: async (uri: string) => new TextEncoder().encode(uri),
}));
vi.mock('@/buzz/runtime-config', () => ({
  getBuzzRuntimeConfig: () => ({ monolithUrl: server.url }),
}));
vi.mock('@/auth/monolith-session', () => ({
  monolithSession: { fetch: (input: string, init: RequestInit) => fetch(input, init) },
}));
vi.mock('@/sync/transport/live-connection', () => ({ sharedLiveConnection: vi.fn() }));

import { BuzzRigTransport } from '@/sync/transport';
import {
  COMPOSER_SINGLE_LINE_INPUT_HEIGHT,
  ConversationComposer,
} from '@/components/buzz/ConversationComposer';
import {
  createChatAttachmentUploader,
  formatAttachmentSize,
  type PickedChatAttachment,
} from './chat-attachment';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const log: string[] = [];
// Each media POST waits here until the test answers it with a status.
let held: { name: string; answer(status: number): void }[] = [];
let http: Server;
beforeAll(async () => {
  http = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const name = Buffer.concat(chunks).toString().replace('file:///cache/', '');
      log.push(`server: ${req.method} ${req.url} (${name})`);
      held.push({
        name,
        answer(status) {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              url: `${server.url}/v1/media/${name}`,
              mimeType: 'text/plain',
              size: 3,
              sha256: 'a'.repeat(64),
            }),
          );
        },
      });
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  server.url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterAll(() => http.close());

const file = (name: string): PickedChatAttachment => ({
  uri: `file:///cache/${name}`,
  name,
  mimeType: 'text/plain',
  size: 3,
  source: 'file',
});
const mediaPosts = () => log.filter((line) => line.includes('/v1/phone/media')).length;

let sent: unknown[] = [];
function Surface({
  transport,
  staged,
}: {
  transport: BuzzRigTransport | null;
  staged: PickedChatAttachment[];
}) {
  const [pendingAttachments, setPending] = React.useState<PickedChatAttachment[]>([]);
  const pendingAttachmentsRef = React.useRef<PickedChatAttachment[]>([]);
  pendingAttachmentsRef.current = pendingAttachments;
  const [attachmentUploader] = React.useState(createChatAttachmentUploader);
  const [, setAttachmentUploadRevision] = React.useState(0);
  React.useEffect(
    () =>
      attachmentUploader.subscribe(() => setAttachmentUploadRevision((revision) => revision + 1)),
    [attachmentUploader],
  );
  React.useEffect(() => {
    attachmentUploader.retain(pendingAttachments);
    if (!transport || pendingAttachments.length === 0) return;
    void transport
      .ensureClient()
      .then((client) =>
        attachmentUploader.start(
          client,
          pendingAttachments.filter((attachment) =>
            pendingAttachmentsRef.current.includes(attachment),
          ),
        ),
      )
      .catch(() => undefined);
  }, [attachmentUploader, pendingAttachments, transport]);
  React.useEffect(() => setPending(staged), [staged]);
  return (
    <ConversationComposer
      value=""
      canSend
      height={COMPOSER_SINGLE_LINE_INPUT_HEIGHT}
      focused={false}
      disabled={false}
      attachments={pendingAttachments.map((attachment) => ({
        uri: attachment.uri,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeLabel: formatAttachmentSize(attachment.size),
        uploadState: attachmentUploader.state(attachment),
      }))}
      onRemoveAttachment={(index) =>
        setPending((current) => current.filter((_, attachmentIndex) => attachmentIndex !== index))
      }
      onRetryAttachment={(index) => {
        const attachment = pendingAttachments[index];
        if (!transport || !attachment) return;
        void transport
          .ensureClient()
          .then((client) => attachmentUploader.start(client, [attachment]))
          .catch(() => undefined);
      }}
      onBlur={() => {}}
      onChangeText={() => {}}
      onContentSizeChange={() => {}}
      onFocus={() => {}}
      onKeyPress={() => {}}
      onSend={() =>
        void transport!
          .ensureClient()
          .then((client) => attachmentUploader.uploadAll(client, pendingAttachments))
          .then((attachments) => {
            sent = attachments;
          })
      }
    />
  );
}

const rowMeta = (renderer: any, index: number) =>
  [renderer.root.findByProps({ testID: `pending-chat-attachment-meta-${index}` }).props.children]
    .flat(4)
    .map((part: any) => (typeof part === 'string' ? part : [part.props.children].flat().join('')))
    .join('');
const hasRetry = (renderer: any, index: number) =>
  renderer.root.findAllByProps({ testID: `pending-chat-attachment-retry-${index}` }).length > 0;
const phone = () =>
  new BuzzRigTransport({ publicKey: 'viewer', secretKey: new Uint8Array(32) } as never);
const answerNext = async (status: number) => {
  await vi.waitFor(() => expect(held.length).toBeGreaterThan(0));
  await act(async () => {
    held.shift()!.answer(status);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
};
const press = async (renderer: any, testID: string) =>
  act(async () => {
    renderer.root.findByProps({ testID }).props.onPress();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

beforeEach(() => {
  log.length = 0;
  held = [];
  sent = [];
});

describe('Reproduction upload-1: a staged attachment shows its background upload', () => {
  for (const room of ['warm', 'cold'] as const) {
    it(`${room} Room: Uploading… as soon as it is added, Ready before Send, one upload`, async () => {
      const transport = phone();
      const staged = [file('photo.txt')];
      let renderer: any;
      await act(async () => {
        renderer = create(
          <Surface transport={room === 'warm' ? transport : null} staged={staged} />,
        );
      });
      log.push(`client: staged photo.txt; row shows "${rowMeta(renderer, 0)}"`);
      expect(rowMeta(renderer, 0)).toBe('Uploading… · 3 B · TEXT/PLAIN');
      if (room === 'cold') {
        await act(async () => renderer.update(<Surface transport={transport} staged={staged} />));
        log.push('client: Room adopted its transport');
      }
      await vi.waitFor(() => expect(mediaPosts()).toBe(1));
      log.push(`client: upload in flight; row shows "${rowMeta(renderer, 0)}"`);
      expect(rowMeta(renderer, 0)).toBe('Uploading… · 3 B · TEXT/PLAIN');
      await answerNext(201);
      log.push(`client: before Send, row shows "${rowMeta(renderer, 0)}"`);
      expect(rowMeta(renderer, 0)).toBe('Ready · 3 B · TEXT/PLAIN');

      log.push('client: Send pressed');
      await press(renderer, 'chat-send');
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      log.push(`client: sent ${sent.length} attachment after ${mediaPosts()} media POST`);
      console.log(`${room} Room:\n  ${log.join('\n  ')}`);
      expect(mediaPosts()).toBe(1);
    });
  }

  it('a failed upload shows Upload failed with Retry, and Retry re-uploads only that file', async () => {
    const transport = phone();
    const staged = [file('a.txt'), file('b.txt')];
    let renderer: any;
    await act(async () => {
      renderer = create(<Surface transport={transport} staged={staged} />);
    });
    await answerNext(201);
    await answerNext(503);
    log.push(`client: rows show "${rowMeta(renderer, 0)}" and "${rowMeta(renderer, 1)}"`);
    expect(rowMeta(renderer, 0)).toBe('Ready · 3 B · TEXT/PLAIN');
    expect(rowMeta(renderer, 1)).toBe('Upload failed · 3 B · TEXT/PLAIN');
    expect(hasRetry(renderer, 0)).toBe(false);
    expect(hasRetry(renderer, 1)).toBe(true);

    log.push('client: Retry pressed on b.txt');
    await press(renderer, 'pending-chat-attachment-retry-1');
    expect(rowMeta(renderer, 1)).toBe('Uploading… · 3 B · TEXT/PLAIN');
    await answerNext(201);
    log.push(`client: rows show "${rowMeta(renderer, 0)}" and "${rowMeta(renderer, 1)}"`);
    expect(rowMeta(renderer, 1)).toBe('Ready · 3 B · TEXT/PLAIN');
    expect(hasRetry(renderer, 1)).toBe(false);

    await press(renderer, 'chat-send');
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    console.log(`failure and retry:\n  ${log.join('\n  ')}`);
    expect(log.filter((line) => line.includes('(a.txt)'))).toHaveLength(1);
    expect(log.filter((line) => line.includes('(b.txt)'))).toHaveLength(2);
  });

  it('Send with a failed attachment uploads it once more and sends it', async () => {
    const transport = phone();
    const staged = [file('a.txt')];
    let renderer: any;
    await act(async () => {
      renderer = create(<Surface transport={transport} staged={staged} />);
    });
    await answerNext(503);
    expect(rowMeta(renderer, 0)).toBe('Upload failed · 3 B · TEXT/PLAIN');

    await press(renderer, 'chat-send');
    expect(rowMeta(renderer, 0)).toBe('Uploading… · 3 B · TEXT/PLAIN');
    await answerNext(201);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(mediaPosts()).toBe(2);
  });

  it('removing a staged attachment drops its row and upload state', async () => {
    const transport = phone();
    const staged = [file('a.txt')];
    let renderer: any;
    await act(async () => {
      renderer = create(<Surface transport={transport} staged={staged} />);
    });
    await answerNext(503);
    await press(renderer, 'pending-chat-attachment-remove-0');
    expect(renderer.root.findAllByProps({ testID: 'pending-chat-attachment-0' })).toHaveLength(0);
  });
});
