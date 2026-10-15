import React from 'react';
import { View } from 'react-native';
export function IdentityMark({ size, testID }) {
  return (
    <View
      testID={testID}
      style={{ width: size, height: size, backgroundColor: '#8a6323', borderRadius: 8 }}
    />
  );
}
