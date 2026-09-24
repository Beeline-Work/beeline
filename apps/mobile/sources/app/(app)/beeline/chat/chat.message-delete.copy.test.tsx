import { readFileSync } from 'node:fs';
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/buzz/HullDialog', async () => {
  const ReactModule = await import('react');
  return { HullDialog: (props: any) => ReactModule.createElement('HullDialog', props) };
});

import { WebAlertModal } from '@/modal/components/WebAlertModal';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const originalConsoleError = console.error;
beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
    originalConsoleError(message, ...args);
  });
});
afterAll(() => vi.restoreAllMocks());

const chat = readFileSync(new URL('./_chat-surface.tsx', import.meta.url), 'utf8');

function messageActionsSheet(): string {
  const start = chat.indexOf('testID="message-actions-sheet"');
  const end = chat.indexOf('</HullActionSheetModal>', start);
  return chat.slice(start, end);
}

function deleteRow(): string {
  const sheet = messageActionsSheet();
  const anchor = sheet.indexOf('testID="message-delete-action"');
  const start = sheet.lastIndexOf('<HullActionSheetRow', anchor);
  const end = sheet.indexOf('/>', anchor);
  return sheet.slice(start, end + 2);
}

function handleDeleteMessage(): string {
  const start = chat.indexOf('const handleDeleteMessage = useCallback(');
  const end = chat.indexOf('[canDeleteMessage, decodedId, refreshSignal]', start);
  return chat.slice(start, end);
}

describe('message delete copy', () => {
  it('paints Delete on the message sheet row and confirm action', () => {
    const label = /label="([^"]+)"/.exec(deleteRow())?.[1];
    const confirmText = /confirmText: '([^']+)'/.exec(handleDeleteMessage())?.[1];
    expect(label, 'message sheet delete row').toBe('Delete');
    expect(confirmText, 'confirm action').toBe('Delete');
    expect(handleDeleteMessage()).toContain("monolithPhoneOperation('deleteRoomMessage'");

    let renderer: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <WebAlertModal
          config={{
            cancelText: 'Cancel',
            confirmText,
            destructive: true,
            id: 'message-delete-confirm',
            message:
              'The message text and attachments will be removed. A deleted-message record will remain in this Room.',
            title: 'Delete message?',
            type: 'confirm',
          }}
          onClose={() => undefined}
          onConfirm={() => undefined}
        />,
      );
    });
    const submit = renderer!.root
      .findByType('HullDialog' as any)
      .props.actions.find((action: { testID: string }) => action.testID === 'hull-confirm-submit');

    // Reproduction 1 — the painted confirm action a person taps.
    console.log(`message sheet action: ${label}`);
    console.log(`confirm action: ${submit.label}`);
    expect(submit.label).toBe('Delete');
  });
});
