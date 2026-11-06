import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    setupFiles: ['../../tests/helpers/phone.ts'],
    include: ['sources/**/*.{spec,test}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/**', 'dist/**', '**/*.d.ts', '**/*.config.*', '**/mockData/**'],
    },
  },
  resolve: {
    alias: {
      'react-native-keyboard-controller': resolve('node_modules/react-native-keyboard-controller'),
      'expo-font': resolve('node_modules/expo-font'),
      'expo-modules-core': resolve('node_modules/expo-modules-core'),
      'expo-constants': resolve('node_modules/expo-constants'),
      'react-native-device-info': resolve('node_modules/react-native-device-info'),
      'expo-haptics': resolve('node_modules/expo-haptics'),
      'expo-keep-awake': resolve('node_modules/expo-keep-awake'),
      '@expo/vector-icons': resolve('node_modules/@expo/vector-icons'),
      'react-native-svg': resolve('node_modules/react-native-svg'),
      'react-native-reanimated': resolve('node_modules/react-native-reanimated'),
      'react-native-unistyles': resolve('node_modules/react-native-unistyles'),
      '@react-native-async-storage/async-storage': resolve('node_modules/@react-native-async-storage/async-storage'),
      react: resolve('node_modules/react'),
      vitest: resolve('node_modules/vitest'),
      '@beeline/push-gateway/projection': resolve('../push-gateway/src/room-indexer-projection.ts'),
      '@beeline/auth/github': resolve('../auth/src/github.ts'),
      '@': resolve('./sources'),
    },
  },
});
