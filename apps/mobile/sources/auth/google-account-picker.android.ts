import { requireOptionalNativeModule } from 'expo-modules-core';

// Old binaries keep their browser ceremony after an OTA. A new store build
// always uses Credential Manager on Android.
export const googleAccountPicker = requireOptionalNativeModule<{
  signIn(serverClientId: string, nonce: string): Promise<string>;
}>('GoogleAccountPicker');
