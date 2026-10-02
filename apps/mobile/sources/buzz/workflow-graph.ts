import type { WorkflowContract, WorkflowState } from '@beeline/api-contract/phone';

/**
 * The run page's state graph, laid out as data (DESIGN.md → Workflow graph).
 *
 * Every state is one circle on one 64pt row. A state's first outcome continues
 * on its own lane; each other outcome curves onto a lane to the right, and the
 * state it reaches is drawn on that lane, so every branch ends in a state. A
 * terminal is drawn once at the end of each branch that reaches it. An outcome
 * that targets an earlier row — including `loop.onExceeded` — is a back edge:
 * it returns up a loop lane on the left and wears an up chevron at the state it
 * repeats. Lanes are assigned so no two lines share a stretch of lane and no
 * line runs through a circle.
 *
 * Pure: contract + the run's ordered handoff history in, rows/edges/chevrons
 * with absolute coordinates out. The page draws them in one SVG gutter.
 */

export const GRAPH_ROW = 64;
/** The circle's centre within its row: level with the first line of the row's copy. */
export const GRAPH_NODE_Y = 22.5;
export const GRAPH_LANE = 18;
/** The innermost loop lane's x. With one loop lane the main lane sits at 28, as in the mock. */
const FIRST_LANE_X = 10;
const NODE_RADIUS = 4.5;
const GUTTER_TRAIL = 14;

export type WorkflowGraphStep = {
  readonly fromState?: string;
  readonly outcome?: string;
  readonly toState: string;
  readonly at?: number;
};

export type GraphReach = 'current' | 'traversed' | 'reachable' | 'unreachable';

export type GraphRow = {
  /** Unique per row: the state name, or `state@source` for a terminal copy. */
  readonly key: string;
  readonly state: string;
  readonly kind: 'handoff' | 'gate' | 'server' | 'waiting' | 'terminal';
  readonly terminalStatus?: 'done' | 'failed' | 'abandoned';
  /** Lane column: 0 is the main lane, positive columns branch to the right. */
  readonly column: number;
  readonly x: number;
  readonly y: number;
  /** current: the pulsing dot; traversed: brass; reachable/unreachable: hollow, the latter ghosted. */
  readonly reach: GraphReach;
  /** Outcomes of the edges drawn into this row (a terminal copy's reason). */
  readonly inOutcomes: readonly string[];
  /** A terminal only an `implicitEdges` jump reaches, drawn with no ordinary edge into it. */
  readonly implicit: boolean;
  /** How many times the run entered this state. */
  readonly visits: number;
  /** The outcome the run last left this state by. */
  readonly lastOutcome?: string;
  /** When the run last entered this state. */
  readonly enteredAt?: number;
  /** For a state that owns a capped loop: times its loop edge was taken, and the cap. */
  readonly loop?: { readonly taken: number; readonly cap: number };
};

export type GraphEdge = {
  readonly kind: 'straight' | 'fork' | 'merge' | 'back';
  readonly from: number;
  readonly to: number;
  readonly outcomes: readonly string[];
  readonly traversed: boolean;
  /** SVG path in the gutter's coordinates. */
  readonly path: string;
};

export type GraphChevron = { readonly path: string; readonly traversed: boolean };

export type WorkflowGraphLayout = {
  readonly rows: readonly GraphRow[];
  readonly edges: readonly GraphEdge[];
  readonly chevrons: readonly GraphChevron[];
  readonly width: number;
  readonly height: number;
  /** Rows a lane's line occupies, per column (positive) and loop lane (negative), for tests. */
  readonly laneSpans: ReadonlyArray<{ column: number; from: number; to: number }>;
};

type Out = { target: string; outcomes: string[] };
type RawEdge = { from: number; to: number; outcomes: string[]; straight?: boolean };
type Placed = { state: string; track: number; implicit: boolean };

function kindOf(state: WorkflowState | undefined): GraphRow['kind'] {
  if (!state) return 'handoff';
  return state.kind === undefined ? 'handoff' : state.kind;
}

function outgoing(contract: WorkflowContract, name: string): Out[] {
  const state = contract.handoffs[name];
  if (!state || state.kind === 'terminal' || state.kind === 'waiting') return [];
  const groups: Out[] = [];
  const add = (outcome: string, target: string) => {
    let group = groups.find((entry) => entry.target === target);
    if (!group) {
      group = { target, outcomes: [] };
      groups.push(group);
    }
    if (!group.outcomes.includes(outcome)) group.outcomes.push(outcome);
  };
  for (const [outcome, target] of Object.entries(state.on)) add(outcome, target);
  if ('loop' in state && state.loop) add(state.loop.onEdge, state.loop.onExceeded);
  return groups;
}

const overlaps = (a: { from: number; to: number }, b: { from: number; to: number }) =>
  a.from <= b.to && b.from <= a.to;

/** Smallest column at or above `min` whose spans do not overlap `span`. */
function assignColumn(
  taken: Map<number, Array<{ from: number; to: number }>>,
  span: { from: number; to: number },
  min: number,
): number {
  for (let column = min; ; column += 1) {
    const spans = taken.get(column) ?? [];
    if (spans.every((other) => !overlaps(other, span))) {
      spans.push(span);
      taken.set(column, spans);
      return column;
    }
  }
}

/** Where a line meets a circle's side at `dy` from its centre. */
function sideX(x: number, dy: number, side: -1 | 1): number {
  return x + side * Math.sqrt(NODE_RADIUS * NODE_RADIUS - dy * dy);
}

/** Even attachment offsets for `count` lines leaving one side of a circle. */
function slots(count: number): number[] {
  if (count <= 1) return [0];
  const spread = 3.5;
  return Array.from({ length: count }, (_, index) => -spread + (2 * spread * index) / (count - 1));
}

const fmt = (value: number) => Number(value.toFixed(2)).toString();
const pt = (x: number, y: number) => `${fmt(x)} ${fmt(y)}`;

export function layoutWorkflowGraph(
  contract: WorkflowContract,
  history: readonly WorkflowGraphStep[] = [],
): WorkflowGraphLayout {
  const states = contract.handoffs;
  const isTerminal = (name: string) => states[name]?.kind === 'terminal';
  const placed: Placed[] = [];
  const tracks: number[][] = [];
  const rowOf = new Map<string, number>();
  const forwards: RawEdge[] = [];
  const backs: RawEdge[] = [];
  const pending = new Map<string, Array<{ source: number; outcomes: string[] }>>();
  const queue: string[] = [];

  const newTrack = () => tracks.push([]) - 1;
  const place = (state: string, track: number, implicit = false) => {
    const row = placed.push({ state, track, implicit }) - 1;
    tracks[track]!.push(row);
    if (!isTerminal(state)) rowOf.set(state, row);
    return row;
  };

  const chain = (start: string, track: number) => {
    let state = start;
    for (;;) {
      const row = place(state, track);
      if (isTerminal(state)) return;
      let continuation: Out | undefined;
      const branches: Out[] = [];
      for (const out of outgoing(contract, state)) {
        if (!isTerminal(out.target) && rowOf.has(out.target)) {
          backs.push({ from: row, to: rowOf.get(out.target)!, outcomes: out.outcomes });
        } else if (!continuation) continuation = out;
        else branches.push(out);
      }
      for (const branch of branches) {
        if (isTerminal(branch.target)) {
          const copy = place(branch.target, newTrack());
          forwards.push({ from: row, to: copy, outcomes: branch.outcomes });
        } else {
          const sources = pending.get(branch.target) ?? [];
          sources.push({ source: row, outcomes: branch.outcomes });
          pending.set(branch.target, sources);
          if (!queue.includes(branch.target)) queue.push(branch.target);
        }
      }
      if (!continuation) return;
      forwards.push({ from: row, to: placed.length, outcomes: continuation.outcomes, straight: true });
      state = continuation.target;
    }
  };

  if (states[contract.start]) chain(contract.start, newTrack());
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (!rowOf.has(next)) chain(next, newTrack());
  }
  // States no ordinary edge reaches: implicit terminals, then anything left over.
  const implicitRows = new Map<string, number>();
  for (const name of contract.implicitEdges ?? []) {
    if (states[name]) implicitRows.set(name, place(name, newTrack(), true));
  }
  for (const name of Object.keys(states)) {
    if (!isTerminal(name) && !rowOf.has(name)) chain(name, newTrack());
    else if (isTerminal(name) && !placed.some((entry) => entry.state === name))
      place(name, newTrack(), true);
  }
  for (const [state, sources] of pending) {
    const target = rowOf.get(state);
    if (target === undefined) continue;
    for (const { source, outcomes } of sources) forwards.push({ from: source, to: target, outcomes });
  }

  // The run: which edges and rows it traversed.
  const edgeKey = (from: number, to: number) => `${from}>${to}`;
  const traversedEdges = new Set<string>();
  const traversedRows = new Set<number>();
  const visits = new Map<number, number>();
  const lastOutcome = new Map<string, string>();
  const enteredAt = new Map<number, number>();
  const loopTaken = new Map<string, number>();
  let lastRow: number | undefined;
  const allRaw = () => [...forwards, ...backs];
  const findEdge = (from: number, toState: string) =>
    allRaw().find((edge) => edge.from === from && placed[edge.to]!.state === toState);
  for (const step of history) {
    let row: number | undefined;
    const from = step.fromState !== undefined ? rowOf.get(step.fromState) : undefined;
    if (from !== undefined) {
      if (step.outcome) lastOutcome.set(step.fromState!, step.outcome);
      const declared = states[step.fromState!];
      if (declared && 'loop' in declared && declared.loop && declared.loop.onEdge === step.outcome)
        loopTaken.set(step.fromState!, (loopTaken.get(step.fromState!) ?? 0) + 1);
      let edge = findEdge(from, step.toState);
      if (!edge && implicitRows.has(step.toState)) {
        edge = { from, to: implicitRows.get(step.toState)!, outcomes: [] };
        forwards.push(edge);
      }
      if (edge) {
        if (step.outcome && !edge.outcomes.includes(step.outcome)) edge.outcomes.push(step.outcome);
        traversedEdges.add(edgeKey(edge.from, edge.to));
        traversedRows.add(edge.from);
        row = edge.to;
      }
    }
    if (row === undefined) {
      row =
        rowOf.get(step.toState) ??
        implicitRows.get(step.toState) ??
        placed.findIndex((entry) => entry.state === step.toState);
      if (row < 0) row = undefined;
    }
    if (row === undefined) continue;
    traversedRows.add(row);
    visits.set(row, (visits.get(row) ?? 0) + 1);
    if (step.at !== undefined) enteredAt.set(row, step.at);
    lastRow = row;
  }
  const currentRow = lastRow !== undefined && !isTerminal(placed[lastRow]!.state) ? lastRow : undefined;

  // Lanes. Forward edges that are not a track's own continuation run down a
  // lane: the lane of the track whose first row they reach, or their own.
  const forkGroups = new Map<number, RawEdge[]>();
  for (const edge of forwards) {
    if (edge.straight) continue;
    const group = forkGroups.get(edge.to) ?? [];
    group.push(edge);
    forkGroups.set(edge.to, group);
  }
  const taken = new Map<number, Array<{ from: number; to: number }>>();
  const trackColumn = new Map<number, number>();
  const laneSpans: Array<{ column: number; from: number; to: number }> = [];
  const mainRows = tracks[0] ?? [];
  if (mainRows.length > 0) {
    const span = { from: mainRows[0]!, to: mainRows[mainRows.length - 1]! };
    taken.set(0, [span]);
    trackColumn.set(0, 0);
    laneSpans.push({ column: 0, ...span });
  }
  // Tracks in creation order: a track's sources always sit on tracks made
  // before it, so their columns are known and the branch can go to their right.
  const columnOfRow = (row: number) => trackColumn.get(placed[row]!.track) ?? 0;
  const groupLane = new Map<number, number>();
  for (let track = 1; track < tracks.length; track += 1) {
    const rows = tracks[track]!;
    const first = rows[0]!;
    const sources = (forkGroups.get(first) ?? []).map((edge) => edge.from);
    const span = { from: Math.min(first, ...sources), to: rows[rows.length - 1]! };
    const min = sources.length > 0 ? Math.max(...sources.map(columnOfRow)) + 1 : 0;
    const column = assignColumn(taken, span, min);
    laneSpans.push({ column, ...span });
    trackColumn.set(track, column);
    if (sources.length > 0) groupLane.set(first, column);
  }
  // Edges into a row partway down a track run on a lane of their own.
  for (const [target, group] of forkGroups) {
    if (groupLane.has(target)) continue;
    const span = { from: Math.min(...group.map((edge) => edge.from)), to: target };
    const column = assignColumn(taken, span, Math.max(...group.map((edge) => columnOfRow(edge.from))) + 1);
    laneSpans.push({ column, ...span });
    groupLane.set(target, column);
  }

  // Loop lanes, one per target row; short loops take the inner lanes.
  // A self-loop is its own group so it never shares a lane with an arrival.
  const backGroups = new Map<string, RawEdge[]>();
  for (const edge of backs) {
    const key = edge.from === edge.to ? `self:${edge.to}` : `${edge.to}`;
    const group = backGroups.get(key) ?? [];
    group.push(edge);
    backGroups.set(key, group);
  }
  const loopTaken2 = new Map<number, Array<{ from: number; to: number }>>();
  const loopLane = new Map<string, number>();
  const loopItems = [...backGroups].map(([key, group]) => ({
    key,
    span: { from: group[0]!.to, to: Math.max(...group.map((edge) => edge.from)) },
  }));
  loopItems.sort(
    (a, b) => a.span.to - a.span.from - (b.span.to - b.span.from) || a.span.from - b.span.from,
  );
  for (const item of loopItems) {
    const lane = assignColumn(loopTaken2, item.span, 0);
    loopLane.set(item.key, lane);
    laneSpans.push({ column: -(lane + 1), ...item.span });
  }
  const loopLaneCount = Math.max(1, loopTaken2.size);
  const mainX = FIRST_LANE_X + GRAPH_LANE * loopLaneCount;
  const columnX = (column: number) => mainX + GRAPH_LANE * column;
  const loopX = (lane: number) => mainX - GRAPH_LANE * (lane + 1);
  const rowY = (row: number) => row * GRAPH_ROW + GRAPH_NODE_Y;
  const rowX = (row: number) => columnX(trackColumn.get(placed[row]!.track) ?? 0);

  // Attachment slots on each circle's left (loop) and right (side forks, merges in) sides.
  const leftSlots = new Map<string, number>();
  const rightSlots = new Map<string, number>();
  const leftLines = new Map<number, Array<{ key: string; order: number }>>();
  const rightLines = new Map<number, Array<{ key: string; order: number }>>();
  const attach = (
    lines: Map<number, Array<{ key: string; order: number }>>,
    row: number,
    key: string,
    order: number,
  ) => {
    const list = lines.get(row) ?? [];
    list.push({ key, order });
    lines.set(row, list);
  };

  // Which fork edges leave from the circle's bottom (one per source) vs its side.
  const forkStyle = new Map<string, 'bottom' | 'side'>();
  const bySource = new Map<number, RawEdge[]>();
  for (const [, group] of forkGroups) for (const edge of group) {
    const list = bySource.get(edge.from) ?? [];
    list.push(edge);
    bySource.set(edge.from, list);
  }
  for (const [source, list] of bySource) {
    const x = rowX(source);
    const ordered = [...list].sort(
      (a, b) => Math.abs(columnX(groupLane.get(a.to)!) - x) - Math.abs(columnX(groupLane.get(b.to)!) - x),
    );
    let bottomUsed = false;
    for (const edge of ordered) {
      const laneX = columnX(groupLane.get(edge.to)!);
      const group = forkGroups.get(edge.to)!;
      const topmost = Math.min(...group.map((entry) => entry.from)) === edge.from;
      const key = edgeKey(edge.from, edge.to);
      if (laneX < x || (topmost && !bottomUsed)) {
        forkStyle.set(key, 'bottom');
        if (laneX >= x) bottomUsed = true;
      } else {
        forkStyle.set(key, 'side');
        // Farther lanes leave higher so their curves pass above the nearer ones.
        attach(rightLines, source, `fork:${key}`, -laneX);
      }
    }
  }
  for (const [target, group] of forkGroups) {
    const laneX = columnX(groupLane.get(target)!);
    const x = rowX(target);
    if (laneX > x) attach(rightLines, target, `merge:${target}`, -1e6);
    else if (laneX < x) attach(leftLines, target, `merge:${target}`, 1e6 - 1);
    void group;
  }
  for (const [key, group] of backGroups) {
    if (key.startsWith('self:')) continue;
    const lane = loopLane.get(key)!;
    const target = group[0]!.to;
    // Inner lanes leave higher; the one arrival enters lowest.
    for (const edge of group) attach(leftLines, edge.from, `depart:${edgeKey(edge.from, edge.to)}`, lane);
    attach(leftLines, target, `arrive:${target}`, 1e6);
  }
  for (const [lines, out] of [
    [leftLines, leftSlots],
    [rightLines, rightSlots],
  ] as const) {
    for (const [, list] of lines) {
      const ordered = [...list].sort((a, b) => a.order - b.order);
      const offsets = slots(ordered.length);
      ordered.forEach((entry, index) => out.set(entry.key, offsets[index]!));
    }
  }

  const edges: GraphEdge[] = [];
  const chevrons: GraphChevron[] = [];
  const isTraversed = (edge: RawEdge) => traversedEdges.has(edgeKey(edge.from, edge.to));
  for (const edge of forwards) {
    const fromX = rowX(edge.from);
    const fromY = rowY(edge.from);
    const toX = rowX(edge.to);
    const toY = rowY(edge.to);
    const traversed = isTraversed(edge);
    if (edge.straight) {
      edges.push({
        kind: 'straight',
        from: edge.from,
        to: edge.to,
        outcomes: edge.outcomes,
        traversed,
        path: `M${pt(fromX, fromY + NODE_RADIUS)} L${pt(toX, toY - NODE_RADIUS)}`,
      });
      continue;
    }
    const laneX = columnX(groupLane.get(edge.to)!);
    const key = edgeKey(edge.from, edge.to);
    let path: string;
    if (forkStyle.get(key) === 'bottom') {
      path =
        `M${pt(fromX, fromY + NODE_RADIUS)} C${pt(fromX, fromY + 21.5)} ` +
        `${pt(laneX, fromY + 15.5)} ${pt(laneX, fromY + 33.5)}`;
    } else {
      const dy = rightSlots.get(`fork:${key}`) ?? 0;
      path =
        `M${pt(sideX(fromX, dy, 1), fromY + dy)} C${pt(fromX + 12, fromY + dy)} ` +
        `${pt(laneX, fromY + dy + 5.5)} ${pt(laneX, fromY + dy + 15.5)}`;
    }
    if (laneX === toX) {
      path += ` L${pt(laneX, toY - NODE_RADIUS)}`;
    } else {
      const side: -1 | 1 = laneX > toX ? 1 : -1;
      const dy = (side === 1 ? rightSlots : leftSlots).get(`merge:${edge.to}`) ?? 0;
      path +=
        ` L${pt(laneX, toY - 14.5)} C${pt(laneX, toY - 6)} ` +
        `${pt(toX + side * 12, toY + dy)} ${pt(sideX(toX, dy, side), toY + dy)}`;
    }
    edges.push({
      kind: laneX === toX ? 'fork' : 'merge',
      from: edge.from,
      to: edge.to,
      outcomes: edge.outcomes,
      traversed,
      path,
    });
  }
  for (const [key, group] of backGroups) {
    const target = group[0]!.to;
    const lane = loopX(loopLane.get(key)!);
    const toX = rowX(target);
    const toY = rowY(target);
    const arrive = leftSlots.get(`arrive:${target}`) ?? 0;
    let groupTraversed = false;
    for (const edge of group) {
      const traversed = isTraversed(edge);
      groupTraversed ||= traversed;
      const fromX = rowX(edge.from);
      const fromY = rowY(edge.from);
      let path: string;
      if (edge.from === target) {
        path =
          `M${pt(fromX - 3.2, fromY + 3.2)} C${pt(lane, fromY + 18)} ` +
          `${pt(lane, fromY - 18)} ${pt(fromX - 3.2, fromY - 3.2)}`;
        const tip = (fromX - 3.2) * 0.25 + lane * 0.75;
        chevrons.push({
          path: `M${pt(tip - 3, fromY + 2)} L${pt(tip, fromY - 2)} L${pt(tip + 3, fromY + 2)}`,
          traversed,
        });
      } else {
        const dy = leftSlots.get(`depart:${edgeKey(edge.from, edge.to)}`) ?? 0;
        const y = fromY + dy;
        const ay = toY + arrive;
        path =
          `M${pt(sideX(fromX, dy, -1), y)} L${pt(lane + 13.5, y)} ` +
          `C${pt(lane + 5, y)} ${pt(lane, y - 4.5)} ${pt(lane, y - 12.5)} ` +
          `L${pt(lane, ay + 15.5)} C${pt(lane, ay + 5.5)} ${pt(lane + 6, ay)} ${pt(lane + 13.5, ay)} ` +
          `L${pt(sideX(toX, arrive, -1), ay)}`;
      }
      edges.push({ kind: 'back', from: edge.from, to: edge.to, outcomes: edge.outcomes, traversed, path });
    }
    if (group.some((edge) => edge.from !== target)) {
      const ay = toY + arrive;
      chevrons.push({
        path: `M${pt(lane - 3, ay + 29.5)} L${pt(lane, ay + 25.5)} L${pt(lane + 3, ay + 29.5)}`,
        traversed: groupTraversed,
      });
    }
  }

  // Which hollow rows the run can still reach from where it stands.
  const reachable = new Set<number>();
  if (currentRow !== undefined) {
    const stack = [currentRow];
    while (stack.length > 0) {
      const row = stack.pop()!;
      if (reachable.has(row)) continue;
      reachable.add(row);
      for (const edge of [...forwards, ...backs]) if (edge.from === row) stack.push(edge.to);
      for (const [, implicitRow] of implicitRows) if (!isTerminal(placed[row]!.state)) stack.push(implicitRow);
    }
  }

  const inOutcomes = new Map<number, string[]>();
  for (const edge of [...forwards, ...backs]) {
    const list = inOutcomes.get(edge.to) ?? [];
    for (const outcome of edge.outcomes) if (!list.includes(outcome)) list.push(outcome);
    inOutcomes.set(edge.to, list);
  }

  const rows: GraphRow[] = placed.map((entry, row) => {
    const declared = states[entry.state];
    const loop = declared && 'loop' in declared ? declared.loop : undefined;
    const reach: GraphReach =
      row === currentRow
        ? 'current'
        : traversedRows.has(row)
          ? 'traversed'
          : reachable.has(row)
            ? 'reachable'
            : 'unreachable';
    const source = forwards.find((edge) => edge.to === row && !edge.straight);
    return {
      key:
        declared?.kind === 'terminal'
          ? `${entry.state}@${entry.implicit ? 'any' : (source?.from ?? forwards.find((edge) => edge.to === row)?.from ?? row)}`
          : entry.state,
      state: entry.state,
      kind: kindOf(declared),
      ...(declared?.kind === 'terminal' ? { terminalStatus: declared.status } : {}),
      column: trackColumn.get(entry.track) ?? 0,
      x: rowX(row),
      y: rowY(row),
      reach,
      inOutcomes: inOutcomes.get(row) ?? [],
      implicit: entry.implicit,
      visits: visits.get(row) ?? 0,
      ...(lastOutcome.has(entry.state) && declared?.kind !== 'terminal'
        ? { lastOutcome: lastOutcome.get(entry.state)! }
        : {}),
      ...(enteredAt.has(row) ? { enteredAt: enteredAt.get(row)! } : {}),
      ...(loop ? { loop: { taken: loopTaken.get(entry.state) ?? 0, cap: loop.cap } } : {}),
    };
  });

  const maxColumn = Math.max(0, ...rows.map((row) => row.column), ...laneSpans.map((span) => span.column));
  // Untraversed lines first, so a brass line always sits on top where lines share a lane.
  edges.sort((a, b) => Number(a.traversed) - Number(b.traversed));
  chevrons.sort((a, b) => Number(a.traversed) - Number(b.traversed));
  return {
    rows,
    edges,
    chevrons,
    width: columnX(maxColumn) + GUTTER_TRAIL,
    height: rows.length * GRAPH_ROW,
    laneSpans,
  };
}

/** `feedback-triage` → `Feedback triage`. */
export function workflowDisplayName(slug: string): string {
  return sentence(slug);
}

/** `ask_human` → `Ask human`. */
export function workflowStateLabel(state: string): string {
  return sentence(state);
}

function sentence(value: string): string {
  const words = value.replace(/[_-]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : value;
}
