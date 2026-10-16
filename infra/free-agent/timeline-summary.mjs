import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
export async function summarizeTimeline(directory) {
  const rows = JSON.parse(await readFile(`${directory}/results.json`, 'utf8'));
  const median = (values) => {
    const sorted = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length
      ? sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2
      : null;
  };
  const details = [];
  const elapsed = (end, start) =>
    Number.isFinite(end) && Number.isFinite(start) ? end - start : null;
  for (const row of rows) {
    const start = Date.parse(row.mention);
    const time = (value) => (value ? Date.parse(value) - start : null);
    const event = (kind) => time(row.events.find((x) => x.kind === kind)?.at);
    const mark = (step) => time(row.marks.find((x) => x.step === step)?.at);
    const log = await readFile(`${directory}/${row.sample}-${row.mode}-helper.log`, 'utf8');
    const ready = [...log.matchAll(/session-start (\S+) room=\S+ step=model-selection/g)]
      .map((x) => x[1])
      .filter((x) => Date.parse(x) >= start)
      .at(-1);
    const boot = row.mode === 'first-boot';
    const timeline = {
      mention: 0,
      wakeRequested: boot
        ? time(row.marks.find((x) => x.step === 'provision-wake-requested')?.requestedAt)
        : event('wake_requested'),
      flyAccepted: mark(boot ? 'fly-create-accepted' : 'fly-start-accepted'),
      machineStarted: elapsed(
        row.flyEvents.find((x) => x.status === 'started' && x.timestamp >= start)?.timestamp,
        start,
      ),
      helperConnected: event('connected'),
      commandClaimed: time(row.commands[0]?.claimed_at),
      sessionReady: time(ready),
      modelRequest: mark('model-request-sent'),
      modelByte: mark('model-first-byte'),
      reply: time(row.reply.created_at),
    };
    const segments = {
      dispatch: timeline.wakeRequested,
      wakeToFlyAccepted: elapsed(timeline.flyAccepted, timeline.wakeRequested),
      machinePreparation: boot ? elapsed(timeline.machineStarted, timeline.flyAccepted) : null,
      helperStartup: row.mode !== 'resume' ? elapsed(timeline.helperConnected, timeline.machineStarted) : null,
      claimToModel: elapsed(timeline.modelRequest, timeline.commandClaimed),
      modelFirstByte: elapsed(timeline.modelByte, timeline.modelRequest),
      byteToReply: elapsed(timeline.reply, timeline.modelByte),
    };
    const sessionSteps = [...log.matchAll(/session-start (\S+) room=\S+ step=(\S+) elapsedMs=(\d+) stepMs=(\d+)/g)]
      .filter((x) => Date.parse(x[1]) >= start)
      .map((x) => ({ step: x[2], elapsedMs: Number(x[3]), stepMs: Number(x[4]), offsetMs: time(x[1]) }));
    details.push({ sample: row.sample, mode: row.mode, timeline, segments, sessionSteps });
  }
  const summaries = Object.fromEntries(
    ['first-boot', 'resume', 'stopped-restart'].map((mode) => {
      const selected = details.filter((x) => x.mode === mode);
      return [
        mode,
        {
          samples: selected.length,
          observations: Object.fromEntries(
            Object.keys(selected[0]?.timeline ?? {}).map((key) => [
              key,
              selected.filter((x) => Number.isFinite(x.timeline[key])).length,
            ]),
          ),
          timeline: Object.fromEntries(
            Object.keys(selected[0]?.timeline ?? {}).map((key) => [
              key,
              median(selected.map((x) => x.timeline[key])),
            ]),
          ),
          segments: Object.fromEntries(
            Object.keys(selected[0]?.segments ?? {}).map((key) => [
              key,
              median(selected.map((x) => x.segments[key])),
            ]),
          ),
        },
      ];
    }),
  );
  const result = { details, summaries };
  await writeFile(`${directory}/summary.json`, JSON.stringify(result, null, 2));
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(await summarizeTimeline(process.argv[2]), null, 2));
