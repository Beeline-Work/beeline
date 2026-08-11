export type CornerStatus = 'live' | 'open' | 'merged' | 'archived';

export type CornerSummary = {
  id: string;
  name: string;
  openerPubkey: string;
  status: CornerStatus;
  createdAt?: number;
};

export const CORNER_NAV_PREVIEW_LIMIT = 3;

const STATUS_ORDER: Record<CornerStatus, number> = {
  live: 0,
  open: 1,
  merged: 2,
  archived: 3,
};

export function cornerName(name: string | undefined, id: string): string {
  const candidate = name?.trim().replace(/^#+/, '').replace(/\s+/g, '-');
  if (!candidate || candidate.startsWith('sub-')) return `corner-${id.slice(0, 8)}`;
  return candidate;
}

export function cornerStatusPresentation(status: CornerStatus): {
  glyph: string;
  label: string;
} {
  switch (status) {
    case 'live':
      return { glyph: '◆', label: 'LIVE' };
    case 'open':
      return { glyph: '◇', label: 'OPEN' };
    case 'merged':
      return { glyph: '✓', label: 'MERGED' };
    case 'archived':
      return { glyph: '□', label: 'ARCHIVED' };
  }
}

export function sortCorners(corners: CornerSummary[]): CornerSummary[] {
  return [...corners].sort((a, b) => {
    const statusDelta = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (statusDelta !== 0) return statusDelta;
    return (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.name.localeCompare(b.name);
  });
}

export function cornerNavigationPreview(corners: CornerSummary[]): CornerSummary[] {
  return sortCorners(corners).slice(0, CORNER_NAV_PREVIEW_LIMIT);
}
