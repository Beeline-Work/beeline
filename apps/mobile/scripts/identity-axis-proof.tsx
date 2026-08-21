import React from 'react';
// @ts-expect-error This isolated proof harness uses the installed react-dom;
// the mobile package intentionally carries no production @types/react-dom.
import { createRoot } from 'react-dom/client';
import {
  IDENTITY_FILL_STATES,
  identityMarkGeometry,
  type IdentityFillState,
  type IdentityKind,
} from '../sources/buzz/identity-mark';
import { IdentityMark } from '../sources/components/buzz/IdentityMark';

const SIZES = [26, 28, 30, 38, 44] as const;
const KINDS: IdentityKind[] = ['agent', 'human', 'workspace'];

function findSeed(
  predicate: (geometry: ReturnType<typeof identityMarkGeometry>) => boolean,
  prefix: string,
): string {
  for (let index = 0; index < 100_000; index += 1) {
    const seed = `${prefix}-${index}`;
    if (predicate(identityMarkGeometry(seed, 'agent'))) return seed;
  }
  throw new Error(`No proof seed found for ${prefix}`);
}

const seedSets = new Map<IdentityKind, Record<IdentityFillState, string>>();

function seedSetFor(kind: IdentityKind): Record<IdentityFillState, string> {
  const cached = seedSets.get(kind);
  if (cached) return cached;
  const byColour = new Map<string, Partial<Record<IdentityFillState, string>>>();
  for (let index = 0; index < 100_000; index += 1) {
    const seed = `proof-${kind}-${index}`;
    const geometry = identityMarkGeometry(seed, kind);
    const group = byColour.get(geometry.palette.mid) ?? {};
    group[geometry.fillState] ??= seed;
    byColour.set(geometry.palette.mid, group);
    if (IDENTITY_FILL_STATES.every((fillState) => group[fillState])) {
      const complete = group as Record<IdentityFillState, string>;
      seedSets.set(kind, complete);
      return complete;
    }
  }
  throw new Error(`No same-colour fill-state set found for ${kind}`);
}

function seedFor(kind: IdentityKind, fillState: IdentityFillState): string {
  return seedSetFor(kind)[fillState];
}

function Mark({
  seed,
  kind,
  size,
  selected,
  alive,
}: {
  seed: string;
  kind: IdentityKind;
  size: number;
  selected?: boolean;
  alive?: boolean;
}) {
  const props = { seed, kind, size, selected };
  const fillState = identityMarkGeometry(seed, kind).fillState;
  return (
    <div
      className="mark-holder"
      data-fill={fillState}
      data-kind={kind}
      data-seed={seed}
      data-selected={selected ? 'true' : 'false'}
      data-size={size}
      style={{ width: size, height: size }}
    >
      {kind === 'agent' ? (
        <IdentityMark {...props} kind="agent" alive={alive} />
      ) : (
        <IdentityMark {...props} />
      )}
    </div>
  );
}

function SizeStrip({ seed, kind, alive }: { seed: string; kind: IdentityKind; alive?: boolean }) {
  return (
    <div className="size-strip">
      {SIZES.map((size) => (
        <div className="size-cell" key={size}>
          <Mark seed={seed} kind={kind} size={size} alive={alive} />
          <span>{size}</span>
        </div>
      ))}
    </div>
  );
}

const agentProofMid = identityMarkGeometry(seedFor('agent', 'hollow'), 'agent').palette.mid;
const orientationA = findSeed(
  ({ palette, fillState, rotation }) =>
    palette.mid === agentProofMid && fillState === 'hollow' && rotation === 0,
  'orientation-a',
);
const orientationB = findSeed(
  ({ palette, fillState, rotation }) =>
    palette.mid === agentProofMid && fillState === 'hollow' && rotation === 1,
  'orientation-b',
);
const densityPool = Array.from({ length: 10_000 }, (_, index) => `density-${index}`)
  .map((seed) => ({ seed, geometry: identityMarkGeometry(seed, 'agent') }))
  .filter(
    ({ geometry }) => geometry.palette.mid === agentProofMid && geometry.fillState === 'hollow',
  )
  .sort(
    (a, b) =>
      a.geometry.cells.filter(({ tone }) => tone !== 'void').length -
      b.geometry.cells.filter(({ tone }) => tone !== 'void').length,
  );
const sparse = densityPool[0]!;
const dense = densityPool[densityPool.length - 1]!;

function Candidate({
  title,
  verdict,
  note,
  children,
}: {
  title: string;
  verdict: 'pass' | 'fail';
  note: string;
  children: React.ReactNode;
}) {
  return (
    <article className="candidate">
      <div className="candidate-head">
        <h3>{title}</h3>
        <span className={verdict}>{verdict}</span>
      </div>
      <div className="candidate-marks">{children}</div>
      <p>{note}</p>
    </article>
  );
}

function App() {
  const closest = [
    { seed: 'closest-isolated-10005', label: '100° · half' },
    { seed: 'closest-isolated-15422', label: '120° · solid' },
  ] as const;

  return (
    <main>
      <header>
        <div>
          <span className="eyebrow">BEELINE · RENDERED COMPONENT PROOF</span>
          <h1>A second identity axis visible at 26dp</h1>
        </div>
        <p className="lede">
          The shipped <code>IdentityMark</code>, rendered in Chrome through react-native-web on
          Obsidian <code>#070708</code>. No silhouette, palette, cypher geometry, or live-ring rule
          changes.
        </p>
      </header>

      <section>
        <div className="section-head">
          <div>
            <span className="eyebrow">WINNER · INTERIOR FILL</span>
            <h2>Solid / hollow / half</h2>
          </div>
          <p>
            Three ordinary names. One stable seed-derived treatment. All detail stays inside type.
          </p>
        </div>
        <div className="matrix">
          {KINDS.flatMap((kind) =>
            IDENTITY_FILL_STATES.map((fillState) => {
              const seed = seedFor(kind, fillState);
              return (
                <div className="matrix-row" key={`${kind}-${fillState}`}>
                  <div className="row-label">
                    <strong>{kind}</strong>
                    <span>{fillState}</span>
                  </div>
                  <SizeStrip seed={seed} kind={kind} />
                </div>
              );
            }),
          )}
        </div>
      </section>

      <section>
        <div className="section-head">
          <div>
            <span className="eyebrow">WORST MEASURED COLOUR PAIR · ΔE00 4.31</span>
            <h2>100° green against 120° green</h2>
          </div>
          <p>
            Same kind, luminance register, rotation, and cypher tones: only colour and fill differ.
          </p>
        </div>
        <div className="closest-grid">
          {closest.map(({ seed, label }) => (
            <div className="closest-card" key={seed}>
              <div className="row-label horizontal">
                <strong>{label}</strong>
                <span>{seed}</span>
              </div>
              <SizeStrip seed={seed} kind="agent" />
            </div>
          ))}
        </div>
      </section>

      <section>
        <div className="section-head">
          <div>
            <span className="eyebrow">CANDIDATE CHECK · ACTUAL 26DP PIXELS</span>
            <h2>Why fill won</h2>
          </div>
          <p>Each comparison uses the shipped component rather than a redrawn facsimile.</p>
        </div>
        <div className="candidate-grid">
          <Candidate
            title="Fill state"
            verdict="pass"
            note="Full-field area survives rasterisation and is immediately nameable: solid, hollow, half."
          >
            {IDENTITY_FILL_STATES.map((fillState) => (
              <div key={fillState}>
                <Mark seed={seedFor('agent', fillState)} kind="agent" size={26} />
                <span>{fillState}</span>
              </div>
            ))}
          </Candidate>
          <Candidate
            title="Stroke weight"
            verdict="fail"
            note="Thin/bold resolves, but frame weight already reports Workspace selection; identity would compete with state."
          >
            <div>
              <Mark seed={seedFor('agent', 'hollow')} kind="agent" size={26} />
              <span>thin</span>
            </div>
            <div>
              <Mark seed={seedFor('agent', 'hollow')} kind="agent" size={26} selected />
              <span>bold</span>
            </div>
          </Candidate>
          <Candidate
            title="Orientation"
            verdict="fail"
            note="Only the nine-cell mesh rotates. At 26dp it becomes an inspection task, not an ordinary-word identity cue."
          >
            <div>
              <Mark seed={orientationA} kind="agent" size={26} />
              <span>0°</span>
            </div>
            <div>
              <Mark seed={orientationB} kind="agent" size={26} />
              <span>120°</span>
            </div>
          </Candidate>
          <Candidate
            title="Interior density"
            verdict="fail"
            note="Sparse/dense is technically measurable but still asks the eye to count nine sub-6dp cells while scrolling."
          >
            <div>
              <Mark seed={sparse.seed} kind="agent" size={26} />
              <span>
                {sparse.geometry.cells.filter(({ tone }) => tone !== 'void').length} cells
              </span>
            </div>
            <div>
              <Mark seed={dense.seed} kind="agent" size={26} />
              <span>{dense.geometry.cells.filter(({ tone }) => tone !== 'void').length} cells</span>
            </div>
          </Candidate>
        </div>
      </section>

      <section className="live-proof">
        <div>
          <span className="eyebrow">LIVE STATE REMAINS OUTSIDE</span>
          <h2>Gold still means one thing</h2>
          <p>The same half-filled agent, idle and working. Fill never touches the ring.</p>
        </div>
        <div className="live-pair">
          <div>
            <Mark seed={seedFor('agent', 'half')} kind="agent" size={44} />
            <span>idle</span>
          </div>
          <div>
            <Mark seed={seedFor('agent', 'half')} kind="agent" size={44} alive />
            <span>working</span>
          </div>
        </div>
      </section>
    </main>
  );
}

const style = document.createElement('style');
style.textContent = `
  :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #070708; color: #f0f0f3; }
  main { width: min(1180px, calc(100vw - 48px)); margin: 0 auto; padding: 56px 0 72px; }
  header { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, .8fr); gap: 48px; align-items: end; padding-bottom: 34px; border-bottom: 1px solid #2e2e36; }
  h1, h2, h3, p { margin: 0; }
  h1 { max-width: 760px; margin-top: 9px; font-size: 42px; line-height: 1.02; letter-spacing: -.035em; }
  h2 { margin-top: 7px; font-size: 24px; line-height: 1.1; letter-spacing: -.02em; }
  h3 { font-size: 15px; }
  p { color: #a9a9b2; font-size: 13px; line-height: 1.55; }
  code, .eyebrow, .row-label, .size-cell span, .candidate-marks span, .live-pair span { font-family: 'IBM Plex Mono', ui-monospace, monospace; }
  code { color: #d2b36f; }
  .eyebrow { color: #c9a24b; font-size: 10px; font-weight: 700; letter-spacing: .13em; }
  .lede { max-width: 460px; }
  section { padding: 34px 0; border-bottom: 1px solid #1c1c21; }
  .section-head { display: grid; grid-template-columns: minmax(0, 1fr) minmax(280px, .7fr); gap: 32px; align-items: end; margin-bottom: 24px; }
  .matrix { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
  .matrix-row { min-width: 0; display: grid; grid-template-columns: 76px minmax(0, 1fr); align-items: center; min-height: 82px; padding: 12px; background: #0c0c0f; border: 1px solid #1c1c21; }
  .row-label { min-width: 0; display: flex; flex-direction: column; gap: 5px; text-transform: uppercase; }
  .row-label strong { color: #e1e1e6; font-size: 10px; letter-spacing: .08em; }
  .row-label span { overflow-wrap: anywhere; color: #777781; font-size: 9px; }
  .row-label.horizontal { flex-direction: row; justify-content: space-between; align-items: center; margin-bottom: 14px; }
  .size-strip { min-width: 0; display: flex; align-items: end; justify-content: space-between; gap: 8px; }
  .size-cell { display: flex; flex-direction: column; align-items: center; gap: 7px; }
  .size-cell span, .candidate-marks span, .live-pair span { color: #686871; font-size: 8px; }
  .mark-holder { flex: none; position: relative; background: #070708; }
  .closest-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .closest-card { min-width: 0; padding: 20px; background: #0c0c0f; border: 1px solid #25252c; }
  .candidate-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
  .candidate { min-width: 0; min-height: 184px; padding: 17px; background: #0c0c0f; border: 1px solid #1c1c21; }
  .candidate-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .candidate-head > span { padding: 3px 6px; border-radius: 2px; font: 700 8px/1 'IBM Plex Mono', monospace; text-transform: uppercase; letter-spacing: .08em; }
  .candidate-head .pass { color: #9dc293; background: #142017; }
  .candidate-head .fail { color: #8d8d96; background: #17171b; }
  .candidate-marks { min-height: 68px; display: flex; align-items: center; gap: 24px; padding: 18px 0 14px; }
  .candidate-marks > div, .live-pair > div { display: flex; flex-direction: column; align-items: center; gap: 8px; }
  .candidate p { font-size: 11px; }
  .live-proof { display: flex; justify-content: space-between; align-items: center; gap: 40px; border-bottom: 0; }
  .live-proof p { margin-top: 9px; }
  .live-pair { display: flex; align-items: center; gap: 34px; padding-right: 38px; }
  @media (max-width: 900px) {
    header, .section-head { grid-template-columns: 1fr; gap: 16px; }
    .matrix { grid-template-columns: 1fr; }
    .candidate-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
`;
document.head.append(style);

const rootNode = document.getElementById('root');
if (!rootNode) throw new Error('Missing #root');
createRoot(rootNode).render(<App />);
