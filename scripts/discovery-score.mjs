/** Deterministic capability routing grades. Wording judgments are separate evidence. */
import { createHash } from 'node:crypto';
import { evaluateRule } from './prompt-case-rules.ts';
import { discoveryResultSucceeded } from './discovery-policy.mjs';
export function tomorrowCron(startedAt) {
    const date = new Date(startedAt);
    if (!Number.isFinite(date.getTime())) return undefined;
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone:'America/New_York',year:'numeric',month:'numeric',day:'numeric'}).formatToParts(date).map(p=>[p.type,p.value]));
    const tomorrow = new Date(Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day)+1));
    return `0 9 ${tomorrow.getUTCDate()} ${tomorrow.getUTCMonth()+1} *`;
}
function responseText(call) {
    return (call.response?.content ?? []).filter(b=>b.type==='text').map(b=>b.text).join('\n');
}
function createdScheduleId(call) {
    const text = responseText(call);
    try { const value=JSON.parse(text); return value.scheduleId ?? value.schedule?.scheduleId; } catch { return text.match(/Schedule ([\w-]+) created:/)?.[1]; }
}
function mailBranchProved(calls) {
    const status = calls.findIndex(c=>c.name==='connect' && c.args.mode==='status');
    if (status < 0) return false;
    const later = calls.slice(status+1);
    // A disconnected fixture must request setup, not pretend schema discovery ran.
    const readiness = responseText(calls[status]);
    const disconnected = /Connections .*none.*Apps .*none/s.test(readiness) ||
        /gmail.{0,30}(disconnected|not connected|not added)/i.test(readiness) ||
        later.some(c=>c.name==='app_tool' && /gmail/i.test(c.args.app??'') && !c.intendedOnly && !c.succeeded);
    return disconnected
        ? later.some(c=>c.name==='connect' && c.args.mode==='ensure' && /gmail/i.test(c.args.service??'') && /invoice|Example Supplies/i.test(c.args.continuation??''))
        : later.some(c=>c.name==='app_tool' && /gmail/i.test(c.args.app??'') && /search/i.test(responseText(c)));
}
export function grade(testCase, observed) {
    const bindings = { ...(observed.room ? { 'fixture-room': observed.room } : {}), ...(observed.startedAt ? {'fixture-tomorrow-cron':tomorrowCron(observed.startedAt)} : {}), ...observed.bindings };
    if (Object.keys(bindings).length) {
        const bind = value => typeof value === 'string' ? (bindings[value] ?? value) : Array.isArray(value) ? value.map(bind) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, bind(entry)])) : value;
        testCase = bind(testCase);
    }
    const transcript = { calls: (observed.calls ?? []).map(call => call.name === 'post' && call.args.address === undefined && bindings['fixture-room'] ? { ...call, args: { ...call.args, address: bindings['fixture-room'] } } : call), text: observed.text ?? '' };
    const forbidden = testCase.forbidden?.find((rule) => evaluateRule(rule, transcript).pass);
    if (forbidden)
        return { status: 'fail', reason: `Forbidden behavior: ${JSON.stringify(forbidden)}` };
    const accepted = { ...transcript, calls: transcript.calls.filter((call) => call.intendedOnly === true || (call.succeeded === true && (!call.response || discoveryResultSucceeded(call.response, call.error)))) };
    let full = evaluateRule(testCase.pass, accepted);
    if (full.pass && testCase.requiresEffect === 'gmail-search-or-disconnected-setup' && !mailBranchProved(accepted.calls))
        full = {pass:false,reason:'Gmail search schema or explicitly disconnected setup branch was not proved'};
    if (full.pass && testCase.id === 'workflow-read') {
        const read = accepted.calls.findIndex(c=>c.name==='app_tool' && c.args.app==='beeline:workflow' && c.args.tool==='read');
        const advance = transcript.calls.findIndex(c=>c.name==='app_tool' && c.args.app==='beeline:workflow' && c.args.tool==='advance');
        const originalRead = transcript.calls.findIndex(c=>c===accepted.calls[read]);
        if (advance >= 0 && (originalRead < 0 || advance < originalRead)) full = {pass:false,reason:'Workflow outcome chosen before reading the pinned run'};
    }
    if (full.pass && testCase.requiresEffect === 'schedule-created-and-deleted') {
        const create = accepted.calls.findIndex(c=>c.name==='wake' && c.args.action==='create');
        const id = create >= 0 ? createdScheduleId(accepted.calls[create]) : undefined;
        if (!id || !accepted.calls.slice(create+1).some(c=>c.name==='wake' && c.args.action==='delete' && c.args.scheduleId===id))
            full = {pass:false,reason:'Deletion does not prove cleanup of the returned scheduleId'};
    }
    // Discovery actions are proved by the required call, not by later prose.
    // Preserve provider/startup errors; only the harness deadline can coexist
    // with a successful action already captured in its trace.
    const provedBeforeDeadline = testCase.expected.kind === 'action' && testCase.capability?.call !== 'post_artifact' && full.pass &&
        observed.error === 'Harness turn timed out' &&
        (testCase.requiresEffect !== 'schedule-created-and-deleted' || observed.effects?.remainingSchedules === 0);
    // post_artifact queues delivery for the final reply; upload alone is not
    // proof that a timed-out turn delivered the file to the Room.
    if ((observed.error || !observed.completed) && !provedBeforeDeadline)
        return { status: 'incomplete', reason: observed.error ?? 'No completed turn' };
    if (full.pass && testCase.requiresEffect === 'schedule-created-and-deleted' &&
        observed.effects?.remainingSchedules !== 0)
        return { status: 'partial', reason: 'Schedule cleanup has no persisted proof' };
    if (full.pass)
        return { status: 'pass', reason: provedBeforeDeadline ? `${full.reason}; required action proved before harness deadline; turn incomplete` : full.reason };
    const capability = evaluateRule(testCase.capability, transcript);
    return { status: capability.pass ? 'partial' : 'fail', reason: full.reason };
}
export function transcriptHash(observed) {
    return createHash('sha256').update(JSON.stringify({ calls: observed.calls ?? [], text: observed.text ?? '' })).digest('hex');
}
export function summarize(cases, observations, judgments = [], rubricHash) {
    const rows = cases.map((c) => {
        const observed = observations.find((r) => r.id === c.id) ?? { error: 'Not run' };
        let verdict = grade(c, observed);
        let provisional = false;
        if (c.expected.kind !== 'action' && verdict.status !== 'incomplete' && !verdict.reason.startsWith('Forbidden behavior:')) {
            const judged = judgments.find((j) => j.caseId === c.id);
            const valid = judged && rubricHash && judged.rubricSha256 === rubricHash &&
                judged.transcriptSha256 === transcriptHash(observed) && typeof judged.model === 'string' && judged.model.length &&
                ['pass', 'partial', 'fail'].includes(judged.status) && typeof judged.evidence === 'string' &&
                judged.evidence.trim().length && observed.text.includes(judged.evidence) && typeof judged.reason === 'string';
            if (valid)
                verdict = { status: judged.status, reason: judged.reason };
            else
                provisional = true;
        }
        return { id: c.id, category: c.category, expected: c.expected, ...verdict, provisional };
    });
    const completed = rows.filter((r) => r.status !== 'incomplete');
    const passed = rows.filter((r) => r.status === 'pass').length;
    return { rows, passed, completed: completed.length, turnsCompleted: observations.filter(o => o.completed && !o.error).length, total: rows.length,
        passRate: completed.length === cases.length && !rows.some((r) => r.provisional) ? passed / cases.length : null,
        provisionalPassRate: completed.length === cases.length ? passed / cases.length : null,
        completedPassRate: completed.length ? passed / completed.length : null,
        gaps: rows.filter((r) => ['fail', 'partial'].includes(r.status)) };
}
