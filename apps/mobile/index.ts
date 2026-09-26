// Must be FIRST: cryptographically-secure random polyfill for Hermes
// (react-native-get-random-values provides crypto.getRandomValues which
// @noble/hashes, @noble/curves, and nostr-tools require at import time).
import 'react-native-get-random-values';

import './sources/polyfills/screenOrientation';
import './sources/unistyles';
import 'expo-router/entry';
import { installNotificationActions } from './sources/push/notification-action-runtime';

// Android answers a notification action in a headless JS runtime that never
// mounts a screen, so the task is defined while the bundle loads.
installNotificationActions();
