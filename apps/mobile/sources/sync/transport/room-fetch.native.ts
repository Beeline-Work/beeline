import { fetch } from 'expo/fetch';

// Expo delivers the body directly instead of passing a Blob through the
// React Native networking and FileReader queues during navigation.
export const fetchOpeningRoom = fetch as typeof globalThis.fetch;
