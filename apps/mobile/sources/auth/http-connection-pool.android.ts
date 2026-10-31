import { requireOptionalNativeModule } from 'expo-modules-core';

// Binaries before this module ignore the call; their requests still end at
// their own deadlines and try the alternate origin.
const pool = requireOptionalNativeModule<{ evictIdleConnections(): void }>('AndroidHttpPool');

/** Close idle pooled connections so the next request opens a fresh one. */
export function evictIdleHttpConnections(): void {
  try {
    pool?.evictIdleConnections();
  } catch {
    // Eviction only speeds recovery; a request never fails because of it.
  }
}
