import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { grade, summarize, transcriptHash } from './discovery-score.mjs';
const corpus = JSON.parse(readFileSync(new URL('../docs/prompts/cases/discovery/corpus.json', import.meta.url)));
const usage = corpus.find((c) => c.id === 'usage');
const observation = { completed: true, calls: [{ name: 'read', args: { facet: 'usage' }, succeeded: true }], text: 'Live usage' };
test('corpus has sixty unique cases and all required outcome classes', () => {
    assert.equal(corpus.length, 60);
    assert.equal(new Set(corpus.map((c) => c.id)).size, 60);
    assert.deepEqual(new Set(corpus.map((c) => c.expected.kind)), new Set(['action', 'feature', 'unsupported']));
    assert.ok(corpus.filter((c) => c.language === 'ar').length >= 5);
    for (const c of corpus) {
        assert.ok(c.request && c.expected.outcome && c.fixTarget);
        assert.doesNotThrow(() => grade(c, observation));
    }
});
test('right capability with wrong facet is partial, exact args pass, invented capability fails', () => {
    assert.equal(grade(usage, observation).status, 'pass');
    assert.equal(grade(usage, { ...observation, calls: [{ name: 'read', args: { facet: 'members' } }] }).status, 'partial');
    assert.equal(grade(usage, { ...observation, calls: [], text: 'I checked your usage.' }).status, 'fail');
});
test('forbidden repository card fails even with otherwise plausible wording', () => {
    const meal = corpus.find((c) => c.id === 'meal');
    assert.equal(grade(meal, { ...observation, text: 'Try a bean stew.', calls: [{ name: 'app_tool', args: { app: 'beeline:onboarding', tool: 'repository' } }] }).status, 'fail');
});
test('infrastructure failure never becomes model failure or an overall pass rate', () => {
    assert.equal(grade(usage, { ...observation, error: 'provider 402' }).status, 'incomplete');
    const result = summarize([usage, { ...usage, id: 'not-run' }], [{ id: 'usage', ...observation }]);
    assert.equal(result.completed, 1);
    assert.equal(result.passRate, null);
    assert.equal(result.completedPassRate, 1);
});
test('cleanup action must follow creation', () => {
    const c = corpus.find((c) => c.id === 'schedule-cleanup');
    const calls = [{ name: 'wake', args: { action: 'create', trigger: 'schedule', cadence: { everyMinutes: 10 } }, succeeded: true }, { name: 'wake', args: { action: 'delete', trigger: 'schedule', scheduleId: 'fixture' }, succeeded: true }];
    assert.equal(grade(c, { completed: true, calls, text: '', effects: { remainingSchedules: 0 } }).status, 'pass');
    assert.equal(grade(c, { completed: true, calls: [...calls].reverse(), text: '' }).status, 'partial');
});
test('an intended safe action or a refused call never counts as performed', () => {
    assert.equal(grade(usage, { completed: true, calls: [{ name: 'read', args: { facet: 'usage' }, succeeded: false }], text: '' }).status, 'partial');
    assert.equal(grade(usage, { completed: true, calls: [{ name: 'read', args: { facet: 'usage' } }], text: '' }).status, 'partial');
});
test('wording needs a trace-bound judge and never overrides a forbidden action', () => {
    const c = corpus.find((c) => c.id === 'meal');
    const observed = { id: c.id, completed: true, calls: [], text: 'Serve vegetable stew with bread.' };
    const judged = { caseId: c.id, status: 'pass', reason: 'Answers the meal request.', evidence: 'vegetable stew', model: 'fixture-judge', rubricSha256: 'rubric', transcriptSha256: transcriptHash(observed) };
    assert.equal(summarize([c], [observed]).passRate, null);
    assert.equal(summarize([c], [observed], [judged], 'rubric').passRate, 1);
    assert.equal(summarize([c], [observed], [{ ...judged, transcriptSha256: 'stale' }], 'rubric').passRate, null);
    const wrong = { ...observed, calls: [{ name: 'app_tool', args: { app: 'beeline:onboarding', tool: 'repository' }, succeeded: true }] };
    const result = summarize([c], [wrong], [{ ...judged, transcriptSha256: transcriptHash(wrong) }], 'rubric');
    assert.equal(result.rows[0].status, 'fail');
    assert.equal(result.passRate, 0);
});
