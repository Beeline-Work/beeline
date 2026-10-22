/** Deterministic capability routing grades. Wording judgments are separate evidence. */
import { createHash } from 'node:crypto';
import { evaluateRule } from './prompt-case-rules.ts';
export function grade(testCase, observed) {
    if (observed.bindings) {
        const bind = value => typeof value === 'string' ? (observed.bindings[value] ?? value) : Array.isArray(value) ? value.map(bind) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, bind(entry)])) : value;
        testCase = bind(testCase);
    }
    const transcript = { calls: observed.calls ?? [], text: observed.text ?? '' };
    const forbidden = testCase.forbidden?.find((rule) => evaluateRule(rule, transcript).pass);
    if (forbidden)
        return { status: 'fail', reason: `Forbidden behavior: ${JSON.stringify(forbidden)}` };
    const accepted = { ...transcript, calls: transcript.calls.filter((call) => call.succeeded === true || call.intendedOnly === true) };
    const full = evaluateRule(testCase.pass, accepted);
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
