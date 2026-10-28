import type { googleAccountPicker as androidPicker } from './google-account-picker.android';

// Keep the fallback's contract aligned with Metro's Android implementation.
// This type-only edge never loads the native module on iOS or web.
export const googleAccountPicker: typeof androidPicker = null;
