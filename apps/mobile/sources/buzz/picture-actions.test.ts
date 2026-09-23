import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  platformOS: { value: 'android' as string },
  setImageAsync: vi.fn(),
  artifactBase64: vi.fn(),
  fetchArtifactBytes: vi.fn(),
  openArtifactInBrowserOrExplain: vi.fn(),
  writeAsStringAsync: vi.fn(),
  isAvailableAsync: vi.fn(),
  shareAsync: vi.fn(),
  alert: vi.fn(),
  actionSheet: vi.fn(),
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return mocks.platformOS.value;
    },
  },
}));
vi.mock('expo-clipboard', () => ({ setImageAsync: mocks.setImageAsync }));
vi.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  EncodingType: { Base64: 'base64' },
  writeAsStringAsync: mocks.writeAsStringAsync,
}));
vi.mock('expo-sharing', () => ({
  isAvailableAsync: mocks.isAvailableAsync,
  shareAsync: mocks.shareAsync,
}));
vi.mock('@/buzz/artifact-link', () => ({
  artifactBase64: mocks.artifactBase64,
  fetchArtifactBytes: mocks.fetchArtifactBytes,
  openArtifactInBrowserOrExplain: mocks.openArtifactInBrowserOrExplain,
}));
vi.mock('@/modal', () => ({
  Modal: { alert: mocks.alert, actionSheet: mocks.actionSheet },
}));

import { copyPicture, sharePicture, showPictureActions } from './picture-actions';

const picture = {
  url: 'https://usebeeline.app/v1/media/9f0f6a50-1111-4222-8333-444455556666',
  name: 'team photo.png',
  mimeType: 'image/png',
  size: 2048,
  kind: 'artifact' as const,
  title: 'Team photo',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.platformOS.value = 'android';
  mocks.artifactBase64.mockResolvedValue('aW1hZ2U=');
  mocks.isAvailableAsync.mockResolvedValue(true);
});

describe('picture actions', () => {
  it('copies the fetched image bytes to the platform clipboard', async () => {
    await expect(copyPicture(picture)).resolves.toBe(true);
    expect(mocks.artifactBase64).toHaveBeenCalledWith(picture);
    expect(mocks.setImageAsync).toHaveBeenCalledWith('aW1hZ2U=');
  });

  it('writes a safe temporary image and opens the native share sheet', async () => {
    await sharePicture(picture);
    expect(mocks.writeAsStringAsync).toHaveBeenCalledWith(
      'file:///cache/shared-team-photo.png',
      'aW1hZ2U=',
      { encoding: 'base64' },
    );
    expect(mocks.shareAsync).toHaveBeenCalledWith('file:///cache/shared-team-photo.png', {
      dialogTitle: 'Share Team photo',
      mimeType: 'image/png',
    });
  });

  it('uses one action list for a message, viewer, or desktop context menu', () => {
    showPictureActions(picture);
    expect(mocks.actionSheet).toHaveBeenCalledWith(
      'Team photo',
      expect.arrayContaining([
        expect.objectContaining({ text: 'Copy image' }),
        expect.objectContaining({ text: 'Share image' }),
        expect.objectContaining({ text: 'Open in browser' }),
      ]),
      { cancelText: 'Cancel' },
    );

    const actions = mocks.actionSheet.mock.calls[0]![1];
    actions[0].onPress();
    actions[1].onPress();
    actions[2].onPress();
    expect(mocks.openArtifactInBrowserOrExplain).toHaveBeenCalledWith(picture);
  });

  it('reports a failed copy to its caller without raising an alert', async () => {
    mocks.artifactBase64.mockRejectedValueOnce(new Error('copy failed'));
    await expect(copyPicture(picture)).resolves.toBe(false);
    expect(mocks.alert).not.toHaveBeenCalled();
  });

  it('speaks action-sheet copy and share failures instead of failing silently', async () => {
    mocks.artifactBase64.mockRejectedValueOnce(new Error('copy failed'));
    showPictureActions(picture);
    await mocks.actionSheet.mock.calls[0]![1][0].onPress();
    await vi.waitFor(() =>
      expect(mocks.alert).toHaveBeenCalledWith(
        'Could not copy image',
        'The image could not be copied. Try again.',
      ),
    );

    mocks.isAvailableAsync.mockResolvedValueOnce(false);
    await sharePicture(picture);
    expect(mocks.alert).toHaveBeenCalledWith(
      'Sharing unavailable',
      'This device cannot share image files.',
    );
  });
});
