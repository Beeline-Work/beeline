import { addPushTokenListener } from 'expo-notifications';

export function subscribePushTokenChanges(listener: () => void): () => void {
  const subscription = addPushTokenListener(listener);
  return () => subscription.remove();
}
