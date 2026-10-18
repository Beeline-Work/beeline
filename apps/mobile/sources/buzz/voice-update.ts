import { Linking } from 'react-native';
import { Modal } from '@/modal/ModalManager';

export const VOICE_UPDATE_MESSAGE = 'Update Beeline in the App Store to join calls.';

async function openVoiceAppStore(): Promise<void> {
  try {
    await Linking.openURL('itms-apps://apps.apple.com/app/id6803948500');
  } catch {
    await Linking.openURL('https://apps.apple.com/app/id6803948500');
  }
}

export function showVoiceJoinError(message: string): void {
  Modal.alert('Conversation mode', message, message === VOICE_UPDATE_MESSAGE ? [
    { text: 'OK' },
    { text: 'Update', onPress: openVoiceAppStore },
  ] : undefined);
}
