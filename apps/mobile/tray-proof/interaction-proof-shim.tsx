// Expo Go's bundled Worklets version differs from the app's. Only the swipe
// wrapper and busy loader are stubbed; the shipped cell, buttons and handlers render natively.
import React from 'react';
import { View } from 'react-native';
export const GestureHandlerRootView = View;
export function Swipeable({ children }: { children: React.ReactNode }) { return <>{children}</>; }
export function PixelLoader() { return <View />; }
