export function percentile(values, fraction) {
  if (!values.length) return null;
  if (values.some(value => !Number.isFinite(value) || value < 0)) throw new Error('Invalid timing sample');
  return [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)];
}
export function summarize(sample, refreshHz) {
  if (!Number.isFinite(refreshHz) || refreshHz <= 0) throw new Error('Measured refresh rate required');
  const values = sample.jsFrameIntervalsMs;
  return {
    scenario: sample.name,
    durationMs: sample.endMs - sample.startMs,
    jsFrameIntervalP50Ms: percentile(values, .5),
    jsFrameIntervalP95Ms: percentile(values, .95),
    // rAF gaps estimate missed JS opportunities, not compositor dropped frames.
    missedJsFrameOpportunities: values.reduce((sum, value) => sum + Math.max(0, Math.round(value * refreshHz / 1000) - 1), 0),
    transcriptCommits: sample.commits.filter(commit => commit.kind === 'transcript').length,
    rowCommits: sample.commits.filter(commit => commit.kind === 'row').length,
    distinctRowsCommitted: new Set(sample.commits.filter(commit => commit.kind === 'row').map(commit => commit.id)).size,
  };
}
