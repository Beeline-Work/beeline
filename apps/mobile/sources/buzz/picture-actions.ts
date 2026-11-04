import * as Clipboard from 'expo-clipboard';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';
import type { AttachmentReference } from '@beeline/buzz-client';

import {
  artifactBase64,
  artifactLocalUri,
  fetchArtifactBytes,
  openArtifactInBrowserOrExplain,
} from '@/buzz/artifact-link';
import { Modal } from '@/modal';
import { mediaIdFromUrl } from './artifact';
import { routerOwnerArtifactAction } from './router-owner';


/** Copies the picture; true once it is on the clipboard. The caller reports the outcome. */
export async function copyPicture(attachment: AttachmentReference): Promise<boolean> {
  try {
    const objectId = mediaIdFromUrl(attachment.url);
    if (objectId) routerOwnerArtifactAction('CopyArtifact', objectId);
    await Clipboard.setImageAsync(await artifactBase64(attachment));
    return true;
  } catch {
    return false;
  }
}

export async function sharePicture(attachment: AttachmentReference): Promise<void> {
  try {
    const objectId = mediaIdFromUrl(attachment.url);
    if (objectId) routerOwnerArtifactAction('SaveArtifact', objectId);
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
    const path = await artifactLocalUri(attachment);
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
    {
      text: 'Copy image',
      // The action sheet has no toast host, so a failure here still speaks
      // through the alert rather than failing silently.
      onPress: () =>
        void copyPicture(attachment).then((copied) => {
          if (!copied) Modal.alert('Could not copy image', 'The image could not be copied. Try again.');
        }),
    },
    { text: 'Share image', onPress: () => void sharePicture(attachment) },
    {
      text: 'Open in browser',
      onPress: () => void openArtifactInBrowserOrExplain(attachment),
    },
  ], { cancelText: 'Cancel' });
}
