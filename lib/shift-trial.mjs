// Fixture-only interaction model. No production data, authentication or delivery.
export const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
export const DAY_LABELS = { unknown: '未登録', available: '入れる', want: '入りたい', rest: 'できれば休み', off: '入れない' };
export const PERIODS = {
  month: { label: '2026年10月', start: '2026-10-01', end: '2026-10-31', deadline: '9月25日 20:00', reminder: '9月24日 20:00' },
  week: { label: '10月5日〜11日', start: '2026-10-05', end: '2026-10-11', deadline: '10月1日 20:00', reminder: '9月30日 20:00' },
};
export function datesFor(mode) {
  const dates = []; const p = PERIODS[mode];
  if (!p) return dates;
  for (let day = new Date(p.start + 'T00:00:00Z'); day.toISOString().slice(0, 10) <= p.end; day.setUTCDate(day.getUTCDate() + 1)) dates.push(day.toISOString().slice(0, 10));
  return dates;
}
export function dayOfWeek(date) { return new Date(date + 'T00:00:00Z').getUTCDay(); }
export function dateLabel(date) { return `${Number(date.slice(5, 7))}/${Number(date.slice(8))}（${WEEKDAYS[dayOfWeek(date)]}）`; }
export function timeLabel(day) { return day.start ? `${day.start}〜${day.nextDay ? '翌' : ''}${day.end}` : ''; }
export function validTime(day) {
  if (!['available', 'want', 'rest'].includes(day.status)) return true;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(day.start || '') || !/^([01]\d|2[0-3]):[0-5]\d$/.test(day.end || '')) return false;
  const mins = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const duration = mins(day.end) + (day.nextDay ? 1440 : 0) - mins(day.start);
  return duration > 0 && duration <= 1440;
}
function validBaseline(b) {
  return b && ['fixed', 'variable'].includes(b.kind) && Array.isArray(b.weekdays) && (b.kind !== 'fixed' || b.weekdays.length > 0) && b.weekdays.every(d => Number.isInteger(d) && d >= 0 && d < 7)
    && Number.isInteger(b.target) && b.target >= 0 && b.target <= (b.targetUnit === 'week' ? 7 : 31)
    && ['week', 'month'].includes(b.targetUnit) && validTime({ ...b, status: 'available' });
}
function validDay(d) { return d && ['off', 'rest', 'available', 'want'].includes(d.status) && validTime(d); }
export function effectiveDay(baseline, changes, date) {
  if (changes[date]) return { ...changes[date], source: '今回の変更' };
  if (baseline.kind === 'fixed' && baseline.weekdays.includes(dayOfWeek(date))) return { status: 'available', start: baseline.start, end: baseline.end, nextDay: baseline.nextDay, source: '普段の条件' };
  return { status: 'unknown', source: '未登録' };
}
export function submittedDay(person, date) {
  return person.submitted ? effectiveDay(person.submitted.baseline, person.submitted.days, date) : { status: 'unknown', source: '未提出' };
}
export function hasDraftChanges(person) {
  return !person.submitted || JSON.stringify({ baseline: person.baseline, days: person.draft }) !== JSON.stringify({ baseline: person.submitted.baseline, days: person.submitted.days });
}
function notice(state, to, kind, text) {
  state.notices.unshift({ id: state.nextId++, to, kind, text });
}
export function createTrial(mode = 'month') {
  const specs = [
    ['a', '田中 はるか', 'fixed', [1, 3, 5], '17:00', '22:00', 3],
    ['b', '佐藤 健', 'fixed', [2, 4, 6], '10:00', '15:00', 3],
    ['c', '鈴木 まい', 'variable', [], '17:00', '22:00', 2],
    ['d', '山本 直子', 'fixed', [1, 2, 4, 5], '10:00', '14:00', 4],
  ];
  const people = specs.map(([id, name, kind, weekdays, start, end, target]) => ({ id, name, baseline: { kind, weekdays, start, end, nextDay: false, target, targetUnit: 'week' }, draft: {}, submitted: null, draftTouched: false, proxyDraft: null }));
  // One submitted example makes submitted vs. unsubmitted visible immediately.
  people[1].submitted = { baseline: structuredClone(people[1].baseline), days: {}, version: 1, proxy: false };
  const s = { version: 1, mode, stage: 'collecting', people, notices: [], nextId: 1, reminded: [], assignments: {}, needs: {}, changes: [] };
  people.forEach(p => notice(s, p.id, '提出案内', `${PERIODS[mode].label}の勤務希望を${PERIODS[mode].deadline}までに確認・提出してください。`));
  return s;
}
export function applyTrial(state, action) {
  const s = structuredClone(state);
  const p = s.people.find(person => person.id === action.personId);
  const buffer = action.proxy && p?.proxyDraft ? p.proxyDraft : p;
  const inPeriod = datesFor(s.mode).includes(action.date);
  const editable = s.stage === 'collecting' || (action.proxy === true && s.stage === 'closed');
  if (action.proxy && p && !p.proxyDraft && ['baseline', 'day', 'submit'].includes(action.type)) throw new Error('管理者の一覧から代理入力を開いてください。');
  if (action.type === 'startProxy') {
    if (!p || s.stage === 'published') throw new Error('公開後は変更依頼で対応してください。');
    const initial = createTrial(s.mode).people.find(person => person.id === p.id);
    p.proxyDraft = { baseline: structuredClone(p.submitted?.baseline || initial.baseline), draft: structuredClone(p.submitted?.days || {}) };
  } else if (action.type === 'baseline') {
    if (!p || !editable || !validBaseline(action.baseline)) throw new Error('普段の条件を確認してください。日数と終了時刻も確認してください。');
    buffer.baseline = structuredClone(action.baseline);
    if (!action.proxy) p.draftTouched = true;
  } else if (action.type === 'day') {
    if (!p || !editable || !inPeriod || (action.day !== null && !validDay(action.day))) throw new Error('変更できません。期間・受付状況・時刻を確認してください。');
    if (action.day === null) delete buffer.draft[action.date]; else buffer.draft[action.date] = structuredClone(action.day);
    if (!action.proxy) p.draftTouched = true;
  } else if (action.type === 'submit') {
    if (!p || !editable || !validBaseline(buffer.baseline)) throw new Error('受付を締め切りました。管理者へご相談ください。');
    if (Object.entries(buffer.draft).some(([date, day]) => !datesFor(s.mode).includes(date) || !validDay(day))) throw new Error('希望の内容を確認してください。');
    if (p.submitted && !hasDraftChanges({ ...p, baseline: buffer.baseline, draft: buffer.draft })) return s;
    p.submitted = { baseline: structuredClone(buffer.baseline), days: structuredClone(buffer.draft), version: (p.submitted?.version || 0) + 1, proxy: !!action.proxy };
    if (!action.proxy) { p.draftTouched = false; p.proxyDraft = null; }
    else if (!p.draftTouched) { p.baseline = structuredClone(buffer.baseline); p.draft = structuredClone(buffer.draft); }
    notice(s, p.id, '提出受付', action.proxy ? '管理者が口頭で受けた勤務希望を代理入力しました。内容を確認してください。' : '勤務希望を受け付けました。出勤日はシフト公開後に確認できます。');
  } else if (action.type === 'remind') {
    if (s.stage !== 'collecting') return s;
    s.people.filter(person => !person.submitted && !s.reminded.includes(person.id)).forEach(person => {
      s.reminded.push(person.id); notice(s, person.id, '締切前のご案内', `${PERIODS[s.mode].label}の勤務希望がまだ届いていません。変更がなくても、確認して提出してください。`);
    });
  } else if (action.type === 'close') {
    if (s.stage === 'collecting') s.stage = 'closed';
  } else if (action.type === 'need') {
    if (!inPeriod || s.stage === 'published' || !Number.isInteger(action.count) || action.count < 0 || action.count > 49) throw new Error('人数を確認してください。');
    s.needs[action.date] = action.count;
  } else if (action.type === 'assign') {
    if (!p || !inPeriod || s.stage === 'published') throw new Error('この予定は変更できません。');
    s.assignments[action.date] ||= {};
    if (s.assignments[action.date][p.id]) { delete s.assignments[action.date][p.id]; return s; }
    const day = submittedDay(p, action.date);
    if (!['available', 'want', 'rest'].includes(day.status)) throw new Error('提出された勤務可能な時間を確認してください。');
    if (day.status === 'rest' && !action.consulted) throw new Error('休み希望です。本人へ相談してから配置してください。');
    s.assignments[action.date][p.id] = { status: 'available', start: day.start, end: day.end, nextDay: day.nextDay, preference: day.status };
  } else if (action.type === 'publish') {
    if (s.stage !== 'closed') throw new Error('受付を締め切ってから公開してください。');
    if (!Object.values(s.assignments).some(day => Object.keys(day).length)) throw new Error('出勤予定を1件以上配置してください。');
    // A later resubmission must not leave an old assignment silently valid.
    for (const [date, entries] of Object.entries(s.assignments)) for (const [id, slot] of Object.entries(entries)) {
      const day = submittedDay(s.people.find(person => person.id === id), date);
      if (!['available', 'want', 'rest'].includes(day.status) || day.status !== slot.preference || timeLabel(day) !== timeLabel(slot)) throw new Error(`${dateLabel(date)}の希望が変わっています。配置を外して確認し直してください。`);
    }
    s.stage = 'published';
    s.people.forEach(person => notice(s, person.id, 'シフト公開', `${PERIODS[s.mode].label}のシフトを公開しました。自分の出勤予定を確認してください。`));
  } else if (action.type === 'change') {
    if (!p || s.stage !== 'published' || !inPeriod || !validDay(action.day)) throw new Error('変更希望を確認してください。');
    if (s.changes.some(c => c.personId === p.id && c.date === action.date && c.status === 'pending')) throw new Error('この日は変更依頼を受付済みです。管理者の確認をお待ちください。');
    s.changes.push({ id: s.nextId++, personId: p.id, date: action.date, day: structuredClone(action.day), status: 'pending' });
    notice(s, 'manager', '変更依頼', `${p.name}さんから${dateLabel(action.date)}の変更希望が届きました。`);
    notice(s, p.id, '変更依頼の受付', `${dateLabel(action.date)}の変更希望を受け付けました。管理者が承認するまで、出勤予定は変わりません。`);
  } else if (action.type === 'resolve') {
    const change = s.changes.find(c => c.id === action.id);
    if (s.stage !== 'published' || !change || change.status !== 'pending') throw new Error('確認済みの変更依頼です。');
    change.status = action.approve ? 'approved' : 'declined';
    if (action.approve) {
      s.assignments[change.date] ||= {};
      if (['off', 'rest'].includes(change.day.status)) delete s.assignments[change.date][change.personId];
      else s.assignments[change.date][change.personId] = { ...change.day, status: 'available' };
    }
    notice(s, change.personId, '変更依頼の結果', `${dateLabel(change.date)}の変更依頼は${action.approve ? '承認され、出勤予定に反映されました。' : '見送られました。元の出勤予定をご確認ください。'}`);
  } else throw new Error('操作を確認してください。');
  return s;
}
