import type { WorkbenchView } from './workbench';

/** The server owns the same summary used by the Connectors list. */
export type WorkbenchSummary = { value: string; attention?: string };
export function workbenchSummary(view: WorkbenchView, _viewerId: string): WorkbenchSummary {
  return view.companies?.summary ?? { value: 'Unavailable' };
}
