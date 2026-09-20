import type { QueryResultRow } from 'pg';
import type { SqlDatabase } from './database.js';

export const PRODUCTION_CORPUS_MESSAGE_COUNT = 35_100;
export const PRODUCTION_CORPUS_SIGNATURE = 'monolith-hot-reads-v1-35100';

/** Budgets are deliberately reviewable policy, not literals hidden in a test. */
export const HOT_READ_BUDGETS_MS = {
  'room-view': 250,
  'room-list': 100,
  'message-history': 100,
  'message-live-delta': 100,
  'presence-candidates': 100,
  'push-candidates': 100,
  'corner-facts': 100,
} as const;

export type HotReadName = keyof typeof HOT_READ_BUDGETS_MS;

/**
 * The two product targets the fanout audit left unproven. They are end-to-end
 * numbers, not query budgets: `LIVE_INTERACTION_TARGET_MS` is a write leaving
 * one member's phone until the row is in another member's hands, and
 * `CLIENT_PAGE_LOAD_TARGET_MS` is a cold surface becoming paintable.
 */
export const LIVE_INTERACTION_TARGET_MS = 150;
export const CLIENT_PAGE_LOAD_TARGET_MS = 450;

/** The route budget every authenticated phone surface answers inside. */
export const ROUTE_P95_BUDGET_MS = 500;

export interface ExplainSample {
  readonly plan: unknown;
  readonly wallMs: number;
}

export interface HotReadResult {
  readonly name: HotReadName;
  readonly budgetMs: number;
  readonly p95Ms: number;
  readonly samples: readonly ExplainSample[];
}

type PlanNode = Record<string, unknown>;

function childPlans(node: PlanNode): PlanNode[] {
  const children = node.Plans;
  return Array.isArray(children)
    ? children.filter((child): child is PlanNode => Boolean(child) && typeof child === 'object')
    : [];
}

function planRoot(plan: unknown): PlanNode | undefined {
  if (!Array.isArray(plan)) return undefined;
  const document = plan[0];
  if (!document || typeof document !== 'object') return undefined;
  const root = (document as PlanNode).Plan;
  return root && typeof root === 'object' ? (root as PlanNode) : undefined;
}

function walkPlan(
  node: PlanNode,
  visit: (node: PlanNode, parent: PlanNode | undefined, ancestors: readonly PlanNode[]) => void,
  parent?: PlanNode,
  ancestors: readonly PlanNode[] = [],
): void {
  visit(node, parent, ancestors);
  for (const child of childPlans(node)) walkPlan(child, visit, node, [...ancestors, node]);
}

export function planViolations(plan: unknown): string[] {
  const root = planRoot(plan);
  if (!root) return ['EXPLAIN did not return a JSON plan'];
  const violations = new Set<string>();
  walkPlan(root, (node, parent, ancestors) => {
    if (node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'messages')
      violations.add('sequential scan over messages');
    const loops = Number(node['Actual Loops'] ?? 0);
    const relationship = String(node['Parent Relationship'] ?? '');
    // A subplan over a bounded message page or MATERIALIZED candidates CTE is
    // finite by construction. #1120 had neither boundary: its subplan hung
    // directly from an all-history `messages` scan.
    const boundedByLimit = ancestors.some((ancestor) => ancestor['Node Type'] === 'Limit');
    if (
      relationship === 'SubPlan' &&
      loops > 1 &&
      parent?.['Relation Name'] === 'messages' &&
      !boundedByLimit
    )
      violations.add(`per-row correlated subquery (${loops} loops)`);
  });
  return [...violations];
}

export function formatPlan(plan: unknown): string {
  return JSON.stringify(plan, null, 2);
}

export function assertHotRead(result: HotReadResult): void {
  const violations = new Set<string>();
  if (result.p95Ms > result.budgetMs)
    violations.add(`p95 ${result.p95Ms.toFixed(1)}ms exceeds ${result.budgetMs}ms budget`);
  for (const sample of result.samples)
    for (const violation of planViolations(sample.plan)) violations.add(violation);
  if (!violations.size) return;
  const worst = [...result.samples].sort((left, right) => right.wallMs - left.wallMs)[0];
  throw new Error(
    `[PRODUCTION-CORPUS REPLAY] ${result.name} failed: ${[...violations].join(', ')}\n` +
      `Offending EXPLAIN (ANALYZE, BUFFERS):\n${formatPlan(worst?.plan)}`,
  );
}

export async function explainHotRead(
  database: SqlDatabase,
  name: HotReadName,
  sql: string,
  values: readonly unknown[],
  sampleCount = 5,
): Promise<HotReadResult> {
  const samples: ExplainSample[] = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const startedAt = performance.now();
    const explained = await database.query<QueryResultRow>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
      [...values],
    );
    const wallMs = performance.now() - startedAt;
    samples.push({ plan: explained.rows[0]?.['QUERY PLAN'], wallMs });
  }
  const ordered = samples.map(({ wallMs }) => wallMs).sort((left, right) => left - right);
  const p95Index = Math.max(0, Math.ceil(ordered.length * 0.95) - 1);
  const result: HotReadResult = {
    name,
    budgetMs: HOT_READ_BUDGETS_MS[name],
    p95Ms: ordered[p95Index] ?? Number.POSITIVE_INFINITY,
    samples,
  };
  assertHotRead(result);
  return result;
}

export function timingTable(results: readonly HotReadResult[]): string {
  return [
    '| hot read | rows | p95 | budget | verdict |',
    '|---|---:|---:|---:|---|',
    ...results.map(
      (result) =>
        `| ${result.name} | ${PRODUCTION_CORPUS_MESSAGE_COUNT.toLocaleString('en-US')} | ${result.p95Ms.toFixed(1)}ms | ${result.budgetMs}ms | green |`,
    ),
  ].join('\n');
}
