import { requireOptionalNativeModule } from 'expo-modules-core';

// Old binaries keep their browser ceremony after an OTA. A new store build
// tries Credential Manager first on Android, with browser fallback on failure.
export const googleAccountPicker = requireOptionalNativeModule<{
  signIn(serverClientId: string, nonce: string): Promise<string>;
}>('GoogleAccountPicker');
