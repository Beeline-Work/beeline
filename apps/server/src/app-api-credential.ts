/** Vault metadata distinguishes an account API credential from app setup and browser sign-in secrets. */
export function isAppApiCredential(metadata: { readonly fieldNames?: readonly string[]; readonly credentialKind?: string }): boolean {
  const fields = (metadata.fieldNames ?? []).map(field => field.toLowerCase().replace(/[^a-z0-9]/g, ''));
  if (fields.some(field => ['accesstoken', 'apikey', 'token', 'bearertoken'].includes(field))) return true;
  if (fields.some(field => ['clientsecret', 'clientid', 'clientkey', 'password'].includes(field))) return false;
  if (/login|password|browser|oauth.?client/i.test(metadata.credentialKind ?? '')) return false;
  // Older syncs did not provide field metadata; retain their established route.
  return true;
}
