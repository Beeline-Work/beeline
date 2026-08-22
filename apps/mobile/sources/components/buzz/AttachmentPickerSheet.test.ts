import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./AttachmentPickerSheet.tsx', import.meta.url), 'utf8');
const chatSource = readFileSync(
  new URL('../../app/(app)/buzz/chat/[channelId].tsx', import.meta.url),
  'utf8',
);

describe('AttachmentPickerSheet', () => {
  it('presents photo and document choices in the branded bottom sheet', () => {
    expect(source).toContain('testID="attachment-picker-sheet"');
    expect(source).toContain('testID="attachment-picker-photo"');
    expect(source).toContain('testID="attachment-picker-document"');
    expect(source).toContain('<HullSurface strength="raised"');
  });

  it('replaces the composer attachment alert while preserving both picker actions', () => {
    expect(chatSource).toContain('<AttachmentPickerSheet');
    expect(chatSource).toContain('onPickDocument={() => void pickDocument()}');
    expect(chatSource).toContain('onPickPhoto={() => void pickPhoto()}');
    expect(chatSource).not.toContain("Alert.alert('Attach to message'");
  });
});
