export const googleAccountPicker: {
  signIn(serverClientId: string, nonce: string): Promise<string>;
} | null = null;
