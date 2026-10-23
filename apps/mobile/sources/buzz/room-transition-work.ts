import { AppState, InteractionManager } from 'react-native';
import { TransitionWork } from './transition-work';

export const roomTransitionWork = new TransitionWork((work) => {
  const task = InteractionManager.runAfterInteractions(work);
  return () => task.cancel();
});
AppState.addEventListener('change', (state) => {
  if (state === 'background' || state === 'inactive') roomTransitionWork.flush();
});
