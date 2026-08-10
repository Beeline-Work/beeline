import AsyncStorage from '@react-native-async-storage/async-storage';

const BACKUP_NUDGE_PREFIX = '@beeline/identity/backup-nudge-dismissed/';

function backupNudgeKey(pubkey: string): string {
  return `${BACKUP_NUDGE_PREFIX}${pubkey}`;
}

export async function isKeyBackupNudgeDismissed(pubkey: string): Promise<boolean> {
  return (await AsyncStorage.getItem(backupNudgeKey(pubkey))) === 'true';
}

export async function dismissKeyBackupNudge(pubkey: string): Promise<void> {
  await AsyncStorage.setItem(backupNudgeKey(pubkey), 'true');
}
