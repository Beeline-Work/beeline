import { AppState, InteractionManager } from 'react-native';
import { TransitionWork } from './transition-work';

export const roomTransitionWork = new TransitionWork((work) => {
  const task = InteractionManager.runAfterInteractions(work);
  return () => task.cancel();
});
AppState.addEventListener('change', (state) => {
  if (state === 'background' || state === 'inactive') roomTransitionWork.flush();
});

/** A response arriving after the background event must be saved there too. */
export function deferRoomWrite(key: string, work: () => Promise<void>): Promise<void> {
  const saved = roomTransitionWork.enqueue(key, work);
  if (AppState.currentState === 'background' || AppState.currentState === 'inactive') {
    roomTransitionWork.flush();
  }
  return saved;
}
