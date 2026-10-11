import { createRequire } from 'node:module';
import { expect, it, vi } from 'vitest';

const taskManager = vi.hoisted(() => ({ defineTask: vi.fn() }));
const notifications = vi.hoisted(() => ({
  registerTaskAsync: vi.fn(() => Promise.resolve()),
  BackgroundNotificationTaskResult: { NewData: 'new', NoData: 'none' },
}));
// The runtime loads the task manager with `require`, so seed Node's cache.
const nodeRequire = createRequire(import.meta.url);
const taskManagerPath = nodeRequire.resolve('expo-task-manager');
nodeRequire.cache[taskManagerPath] = { exports: taskManager } as NodeJS.Module;
vi.mock('expo-notifications', () => notifications);
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));

import { installReadClearTask, READ_CLEAR_TASK } from './read-clear-runtime';

it('registers the read-clear task on Android, where FCM data messages wake it', () => {
  installReadClearTask();
  expect(taskManager.defineTask).toHaveBeenCalledWith(READ_CLEAR_TASK, expect.any(Function));
  expect(notifications.registerTaskAsync).toHaveBeenCalledWith(READ_CLEAR_TASK);
});
