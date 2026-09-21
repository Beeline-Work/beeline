import * as Clipboard from 'expo-clipboard';
import { cacheDirectory, EncodingType, writeAsStringAsync } from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';
import type { AttachmentReference } from '@beeline/buzz-client';

import {
  artifactBase64,
  fetchArtifactBytes,
  openArtifactInBrowserOrExplain,
} from '@/buzz/artifact-link';
import { Modal } from '@/modal';

function safePictureName(name: string): string {
  const safe = name.replace(/[^0-9a-zA-Z._-]/g, '-').replace(/^-+/, '');
  return safe || 'picture';
}

export async function copyPicture(attachment: AttachmentReference): Promise<void> {
  try {
    await Clipboard.setImageAsync(await artifactBase64(attachment));
  } catch {
    Modal.alert('Could not copy image', 'The image could not be copied. Try again.');
  }
}

export async function sharePicture(attachment: AttachmentReference): Promise<void> {
  try {
    if (Platform.OS === 'web') {
      const file = new File([await fetchArtifactBytes(attachment) as unknown as BlobPart], attachment.name, {
        type: attachment.mimeType,
      });
      if (!navigator.share || (navigator.canShare && !navigator.canShare({ files: [file] }))) {
        Modal.alert('Sharing unavailable', 'This browser cannot share image files.');
        return;
      }
      await navigator.share({ files: [file], title: attachment.title ?? attachment.name });
      return;
    }
    if (!(await Sharing.isAvailableAsync())) {
      Modal.alert('Sharing unavailable', 'This device cannot share image files.');
      return;
    }
    if (!cacheDirectory) throw new Error('cache unavailable');
    const path = `${cacheDirectory}shared-${safePictureName(attachment.name)}`;
    await writeAsStringAsync(path, await artifactBase64(attachment), {
      encoding: EncodingType.Base64,
    });
    await Sharing.shareAsync(path, {
      dialogTitle: `Share ${attachment.title ?? attachment.name}`,
      mimeType: attachment.mimeType,
    });
  } catch {
    Modal.alert('Could not share image', 'The image could not be shared. Try again.');
  }
}

export function showPictureActions(attachment: AttachmentReference): void {
  Modal.actionSheet(attachment.title ?? attachment.name, [
    { text: 'Copy image', onPress: () => void copyPicture(attachment) },
    { text: 'Share image', onPress: () => void sharePicture(attachment) },
    {
      text: 'Open in browser',
      onPress: () => void openArtifactInBrowserOrExplain(attachment),
    },
  ], { cancelText: 'Cancel' });
}
