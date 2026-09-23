/**
 * Helper-side dispatch for connectors that have a typed adapter.
 * Lifecycle execution stays in the existing Squire / Google install
 * routines; this file is the lookup those routines go through so a
 * kind string is not the authority.
 */
import { connectorAdapter } from '@beeline/api-contract/workbench';
import { unlinkSync } from 'node:fs';
import { manualGoogleCredentialsSearchPaths } from './connector-google.js';

export function isAdaptedSquire(type: string | undefined): boolean {
  return type !== undefined && connectorAdapter(type)?.kind === 'trusty-squire';
}

export function isAdaptedYoutube(type: string | undefined): boolean {
  return type !== undefined && connectorAdapter(type)?.kind === 'google-youtube';
}

/** YouTube's local grant copy, cleared when the adapter's uninstall runs. */
export function clearYoutubeGrant(
  home: string,
  log: (message: string) => void,
): void {
  try {
    unlinkSync(manualGoogleCredentialsSearchPaths(home)[0]!);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      log(`could not clear YouTube grant: ${error instanceof Error ? error.message : String(error)}`);
  }
}
