import type { CornerLifecycleView } from '@beeline/api-contract/phone';

/**
 * The one inscribed line a corner shows above its transcript once a pull
 * request exists: `PR #840 · 6/15 tests passed · running`. GitHub owns the
 * detail — the line only says which state the PR is in and hands the reader
 * to GitHub through the `↗` affordance the caller hangs beside it.
 *
 * Returns `undefined` when there is no PR yet, so the caller renders nothing.
 * Failure is encoded by the `×` glyph and the failing check's name, never by
 * colour alone.
 */
export function cornerStatusLine(
  lifecycle: CornerLifecycleView | undefined,
  archived: boolean,
): string | undefined {
  const pr = lifecycle?.pr;
  if (!pr) return undefined;
  const prefix = `PR #${pr.number} · `;
  if (pr.mergedAt || lifecycle.outcome === 'landed') return `${prefix}merged`;
  if (archived) return `${prefix}closed`;
  if (pr.mergeability === 'dirty') return `${prefix}merge conflict`;

  const summary = lifecycle.checksSummary;
  const checks = summary?.checks ?? [];
  const total = summary?.total || checks.length;
  const status = summary?.status ?? lifecycle.checks;
  if (total === 0 && status !== 'pending') return `${prefix}no tests configured`;

  switch (status) {
    case 'failing': {
      const failed = checks.filter((check) => check.status === 'failed');
      const count = failed.length || summary?.failing.length || 0;
      const name = failed[0]?.name ?? summary?.failing[0];
      const label = `${count || ''} ${plural(count, 'test')} failed`.trim();
      return name ? `${prefix}${label} × ${titleCase(name)}` : `${prefix}${label}`;
    }
    case 'passing':
      return `${prefix}all ${total} ${plural(total, 'test')} passed`;
    case 'pending': {
      if (total === 0) return `${prefix}tests running`;
      const passed = checks.filter(
        (check) => check.status === 'passed' || check.conclusion === 'skipped',
      ).length;
      return `${prefix}${passed}/${total} ${plural(total, 'test')} passed · running`;
    }
    default:
      return `${prefix}no tests configured`;
  }
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

/** `MOBILE SUITE` → `Mobile suite`: CI job names arrive shouting. */
function titleCase(name: string): string {
  const trimmed = name.trim();
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}
