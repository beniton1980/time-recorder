import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTrial, createTrial, datesFor, effectiveDay, submittedDay, validTime, hasDraftChanges } from '../lib/shift-trial.mjs';

const action = (state, type, other = {}) => applyTrial(state, { type, personId: 'a', ...other });
const off = { status: 'off' };
const rest = { status: 'rest', start: '17:00', end: '22:00', nextDay: false };
function published() {
  let state = action(createTrial(), 'submit');
  state = action(state, 'assign', { date: '2026-10-05' });
  state = action(state, 'close');
  return action(state, 'publish');
}
test('periods enumerate valid dates and weekly data is independent', () => {
  assert.equal(datesFor('month').length, 31);
  assert.deepEqual([datesFor('week')[0], datesFor('week').at(-1)], ['2026-10-05', '2026-10-11']);
  const m = action(createTrial(), 'submit');
  assert.ok(m.people[0].submitted);
  assert.equal(createTrial('week').people[0].submitted, null);
});
test('unsubmitted baseline never becomes manager availability; variable gaps remain unknown', () => {
  const s = createTrial();
  assert.equal(effectiveDay(s.people[0].baseline, {}, '2026-10-05').status, 'available');
  assert.equal(submittedDay(s.people[0], '2026-10-05').source, '未提出');
  assert.throws(() => action(s, 'assign', { date: '2026-10-05' }));
  const next = action(s, 'submit', { personId: 'c' });
  assert.equal(submittedDay(next.people[2], '2026-10-05').status, 'unknown');
});
test('day changes stay drafts until submission, and resubmission retains an immutable old snapshot', () => {
  const original = action(createTrial(), 'submit');
  let next = action(original, 'day', { date: '2026-10-05', day: off });
  assert.equal(submittedDay(next.people[0], '2026-10-05').status, 'available');
  assert.equal(hasDraftChanges(next.people[0]), true);
  next = action(next, 'submit');
  assert.equal(submittedDay(next.people[0], '2026-10-05').status, 'off');
  assert.equal(submittedDay(original.people[0], '2026-10-05').status, 'available');
  assert.equal(next.people[0].submitted.version, 2);
  assert.equal(action(next, 'submit').notices.length, next.notices.length);
});
test('baseline edits do not alter submitted conditions until resubmitted', () => {
  const submitted = action(createTrial(), 'submit');
  let s = action(submitted, 'baseline', { baseline: { ...submitted.people[0].baseline, start: '18:00' } });
  assert.equal(submittedDay(s.people[0], '2026-10-05').start, '17:00');
  s = action(s, 'submit');
  assert.equal(submittedDay(s.people[0], '2026-10-05').start, '18:00');
});
test('reminders target only unsubmitted people, once each, and stop after closure', () => {
  let s = action(createTrial(), 'submit');
  s = action(s, 'remind');
  const notices = s.notices.filter(n => n.kind === '締切前のご案内');
  assert.deepEqual(notices.map(n => n.to).sort(), ['c', 'd']);
  assert.equal(action(s, 'remind').notices.length, s.notices.length);
  assert.equal(action(action(s, 'close'), 'remind').notices.length, s.notices.length);
});
test('closure stops staff changes; proxy entry retains attribution and receipt', () => {
  let s = action(createTrial(), 'close');
  assert.throws(() => action(s, 'day', { date: '2026-10-05', day: off }));
  assert.throws(() => action(s, 'submit'));
  s = action(s, 'startProxy');
  s = action(s, 'day', { date: '2026-10-05', day: off, proxy: true });
  s = action(s, 'submit', { proxy: true });
  assert.equal(s.people[0].submitted.proxy, true);
  assert.equal(submittedDay(s.people[0], '2026-10-05').status, 'off');
  assert.match(s.notices[0].text, /代理入力/);
});
test('proxy input never reveals or overwrites a staff unsent draft', () => {
  let s = action(createTrial(), 'submit');
  s = action(s, 'day', { date: '2026-10-05', day: off });
  s = action(s, 'startProxy');
  assert.equal(s.people[0].proxyDraft.draft['2026-10-05'], undefined);
  s = action(s, 'day', { date: '2026-10-07', day: off, proxy: true });
  s = action(s, 'submit', { proxy: true });
  assert.equal(s.people[0].draft['2026-10-05'].status, 'off');
  assert.equal(s.people[0].draft['2026-10-07'], undefined);
  assert.equal(submittedDay(s.people[0], '2026-10-05').status, 'available');
  assert.equal(submittedDay(s.people[0], '2026-10-07').status, 'off');
});
test('hard unavailability cannot be assigned; soft rest requires consultation', () => {
  let s = action(createTrial(), 'day', { date: '2026-10-05', day: off });
  s = action(s, 'submit');
  assert.throws(() => action(s, 'assign', { date: '2026-10-05' }));
  s = action(s, 'day', { date: '2026-10-05', day: rest }); s = action(s, 'submit');
  assert.throws(() => action(s, 'assign', { date: '2026-10-05' }));
  assert.ok(action(s, 'assign', { date: '2026-10-05', consulted: true }).assignments['2026-10-05'].a);
});
test('stale allocations require reconfirmation after a submitted time or preference changes', () => {
  let s = action(createTrial(), 'submit'); s = action(s, 'assign', { date: '2026-10-05' });
  s = action(s, 'day', { date: '2026-10-05', day: rest }); s = action(s, 'submit'); s = action(s, 'close');
  assert.throws(() => action(s, 'publish'), /希望が変わって/);
  s = action(s, 'assign', { date: '2026-10-05' });
  s = action(s, 'assign', { date: '2026-10-05', consulted: true });
  assert.equal(action(s, 'publish').stage, 'published');
});
test('staff cannot change published assignments; only reviewed requests affect the plan', () => {
  const initial = published();
  assert.throws(() => action(initial, 'day', { date: '2026-10-05', day: off, proxy: true }));
  assert.throws(() => action(initial, 'assign', { date: '2026-10-05' }));
  let s = action(initial, 'change', { date: '2026-10-05', day: off });
  assert.deepEqual(s.assignments, initial.assignments);
  assert.throws(() => action(s, 'change', { date: '2026-10-05', day: off }), /受付済み/);
  const id = s.changes[0].id;
  const declined = action(s, 'resolve', { id, approve: false });
  assert.deepEqual(declined.assignments, initial.assignments);
  s = action(s, 'resolve', { id, approve: true });
  assert.equal(s.assignments['2026-10-05'].a, undefined);
  assert.ok(initial.assignments['2026-10-05'].a);
  assert.throws(() => action(s, 'resolve', { id, approve: true }));
});
test('invalid dates, reversed times, and malformed baseline are rejected; overnight is explicit', () => {
  const s = createTrial('week');
  assert.throws(() => action(s, 'day', { date: '2026-10-12', day: off }));
  assert.throws(() => action(s, 'day', { date: '2026-10-05', day: { status: 'available', start: '22:00', end: '02:00' } }));
  assert.equal(validTime({ status: 'available', start: '22:00', end: '02:00', nextDay: true }), true);
  assert.equal(validTime({ status: 'available', start: '25:00', end: '02:00', nextDay: true }), false);
  assert.throws(() => action(s, 'baseline', { baseline: { ...s.people[0].baseline, weekdays: [] } }));
  assert.throws(() => action(s, 'baseline', { baseline: { ...s.people[0].baseline, target: 8 } }));
});
test('staffing target is advisory; explicit allocations can exceed it without auto-filling unknowns', () => {
  let s = action(createTrial(), 'submit'); s = action(s, 'need', { date: '2026-10-05', count: 0 });
  s = action(s, 'assign', { date: '2026-10-05' }); s = action(s, 'close'); s = action(s, 'publish');
  assert.equal(s.stage, 'published');
  assert.deepEqual(Object.keys(s.assignments['2026-10-05']), ['a']);
  assert.equal(s.people[2].submitted, null);
});
