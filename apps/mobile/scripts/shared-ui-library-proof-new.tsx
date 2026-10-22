import { EmptyState } from '../sources/components/buzz/EmptyState';
import { ErrorBanner } from '../sources/components/buzz/ErrorBanner';
import { HullSwitch } from '../sources/components/buzz/HullSwitch';
import { ShowMoreRow } from '../sources/components/buzz/ShowMoreRow';

/** Shared parts this tree adds; the before tree replaces this module with `null`. */
export const NewParts: {
  EmptyState: typeof EmptyState;
  ErrorBanner: typeof ErrorBanner;
  HullSwitch: typeof HullSwitch;
  ShowMoreRow: typeof ShowMoreRow;
} | null = { EmptyState, ErrorBanner, HullSwitch, ShowMoreRow };
