'use client';

import { useRef, useState, type FormEvent } from 'react';
import { applyTrial, createTrial, datesFor, dayOfWeek, dateLabel, timeLabel, effectiveDay, submittedDay, hasDraftChanges, PERIODS, WEEKDAYS, DAY_LABELS, type Action, type Baseline, type Day, type DayStatus, type Mode, type Trial } from '../../../lib/shift-trial.mjs';
import styles from './shift-trial.module.css';

type Screen = 'staff' | 'manager' | 'notices';
const shortLabels: Record<DayStatus, string> = { unknown: '未登録', off: '入れない', rest: '休み希望', available: '入れる', want: '入りたい' };
const phaseLabels = { collecting: '希望受付中', closed: '調整中', published: '公開済み' };

export default function ShiftTrial() {
  const [workspaces, setWorkspaces] = useState<Record<Mode, Trial>>(() => ({ month: createTrial('month'), week: createTrial('week') }));
  const [mode, setMode] = useState<Mode>('month');
  const [screen, setScreen] = useState<Screen>('staff');
  const [personId, setPersonId] = useState('a');
  const [proxy, setProxy] = useState(false);
  const [selectedDate, setSelectedDate] = useState('2026-10-05');
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const [editingDay, setEditingDay] = useState<Day>({ status: 'available', start: '17:00', end: '22:00', nextDay: false });
  const [useDefault, setUseDefault] = useState(false);
  const [editingBaseline, setEditingBaseline] = useState<Baseline | null>(null);
  const dayDialog = useRef<HTMLDialogElement>(null);
  const profileDialog = useRef<HTMLDialogElement>(null);
  const trial = workspaces[mode];
  const storedPerson = trial.people.find(p => p.id === personId)!;
  const person = proxy && storedPerson.proxyDraft ? { ...storedPerson, ...storedPerson.proxyDraft } : storedPerson;
  const period = PERIODS[mode];
  const dates = datesFor(mode);
  const submittedCount = trial.people.filter(p => p.submitted).length;
  const pendingChanges = trial.changes.filter(c => c.status === 'pending');
  const canEdit = trial.stage === 'collecting' || (proxy && trial.stage === 'closed');
  const dirty = hasDraftChanges(person);
  const visibleNotices = screen === 'notices' ? trial.notices : trial.notices.filter(n => n.to === personId);

  function dispatch(action: Action, success?: string) {
    try {
      const next = applyTrial(trial, action);
      setWorkspaces(prev => ({ ...prev, [mode]: next }));
      setError(''); setFeedback(success || ''); return true;
    } catch (caught) { setError(caught instanceof Error ? caught.message : '内容を確認してください。'); setFeedback(''); return false; }
  }
  function navigate(next: Screen) { setScreen(next); setProxy(false); setError(''); setFeedback(''); }
  function changeMode(next: Mode) { setMode(next); setSelectedDate('2026-10-05'); setProxy(false); setError(''); setFeedback(''); }
  function openDay(date: string) {
    if (!canEdit && trial.stage !== 'published') return;
    setSelectedDate(date);
    const existing = trial.stage === 'published' ? trial.assignments[date]?.[personId] : effectiveDay(person.baseline, person.draft, date);
    setEditingDay({ status: existing?.status === 'unknown' || !existing ? 'available' : existing.status, start: existing?.start || person.baseline.start, end: existing?.end || person.baseline.end, nextDay: existing?.nextDay || false });
    setUseDefault(trial.stage !== 'published' && !person.draft[date]);
    setError(''); dayDialog.current?.showModal();
  }
  function saveDay(e: FormEvent) {
    e.preventDefault();
    const day: Day | null = useDefault ? null : editingDay.status === 'off' ? { status: 'off' } : editingDay;
    const changed = dispatch({ type: trial.stage === 'published' ? 'change' : 'day', personId, date: selectedDate, day, proxy }, trial.stage === 'published' ? '変更を依頼しました。管理者の承認をお待ちください。' : '下書きを変更しました。最後に「希望を提出する」を押してください。');
    if (changed) dayDialog.current?.close();
  }
  function saveBaseline(e: FormEvent) {
    e.preventDefault();
    if (editingBaseline && dispatch({ type: 'baseline', personId, baseline: editingBaseline, proxy }, '普段の条件を変更しました。今回の希望を確認して提出してください。')) profileDialog.current?.close();
  }
  function startProxy(id: string) { if (dispatch({ type: 'startProxy', personId: id })) { setPersonId(id); setProxy(true); setScreen('staff'); } }
  function assign(id: string) {
    const candidate = trial.people.find(p => p.id === id)!;
    const day = submittedDay(candidate, selectedDate);
    const already = !!trial.assignments[selectedDate]?.[id];
    const consulted = !already && day.status === 'rest' ? window.confirm(`${candidate.name}さんは休み希望です。本人に相談し、了承を得ていますか？`) : false;
    if (!already && day.status === 'rest' && !consulted) return;
    dispatch({ type: 'assign', personId: id, date: selectedDate, consulted }, already ? '配置を外しました。' : '出勤予定に追加しました。公開前に内容を確認してください。');
  }
  function publish() {
    if (!window.confirm('配置した出勤予定を公開します。配置していない日は出勤予定なしになります。内容を確認しましたか？')) return;
    dispatch({ type: 'publish' }, 'シフトを公開しました。「通知の確認」で各自への案内を確認できます。');
  }
  function renderTimeFields(day: Day, update: (d: Day) => void) {
    return <><div className={styles.timeFields}>
      <label>開始<input aria-label="開始時刻" type="time" required value={day.start || ''} onChange={e => update({ ...day, start: e.target.value })} /></label>
      <span>〜</span>
      <label>終了<input aria-label="終了時刻" type="time" required value={day.end || ''} onChange={e => update({ ...day, end: e.target.value })} /></label>
    </div><label className={styles.check}><input type="checkbox" checked={!!day.nextDay} onChange={e => update({ ...day, nextDay: e.target.checked })} />終了は翌日</label></>;
  }
  const assignedTotal = Object.values(trial.assignments).reduce((sum, day) => sum + Object.keys(day).length, 0);
  const selfAssigned = dates.filter(date => trial.assignments[date]?.[personId]);
  const selectedAssigned = trial.assignments[selectedDate] || {};
  const need = trial.needs[selectedDate] ?? 2;
  const selectedCount = Object.keys(selectedAssigned).length;

  return <main className={styles.page}>
    <div className={styles.shell}>
      <header className={styles.header}><div><span className={styles.wordmark}>ONOGAMI</span><span className={styles.product}>シフト</span></div><span className={styles.trialBadge}>操作テスト版</span></header>
      <aside className={styles.testNote}>架空の「テスト食堂」で試せます。実際の勤務には使えません。<details><summary>テスト版について</summary><p>入力はこのタブ内だけに保持され、再読み込みで最初に戻ります。端末間の共有・LINE認証・実際の通知送信はありません。通知は画面内で再現します。</p></details></aside>
      <nav className={styles.tabs} aria-label="試す画面">
        <button type="button" aria-current={screen === 'staff' ? 'page' : undefined} onClick={() => navigate('staff')}>スタッフ</button>
        <button type="button" aria-current={screen === 'manager' ? 'page' : undefined} onClick={() => navigate('manager')}>管理者{pendingChanges.length > 0 && <span className={styles.count}>{pendingChanges.length}</span>}</button>
        <button type="button" aria-current={screen === 'notices' ? 'page' : undefined} onClick={() => navigate('notices')}>通知の確認</button>
      </nav>
      <div className={styles.periodRow}><div className={styles.periodSwitch} aria-label="募集の単位"><button aria-pressed={mode === 'month'} onClick={() => changeMode('month')}>月単位</button><button aria-pressed={mode === 'week'} onClick={() => changeMode('week')}>週単位</button></div><span className={styles.phase}>{phaseLabels[trial.stage]}</span></div>
      {feedback && <div className={styles.success} role="status">{feedback}</div>}
      {error && <div className={styles.error} role="alert">{error}</div>}

      {screen === 'staff' && <>
        {proxy && <div className={styles.proxyNote}><strong>管理者による代理入力</strong><button onClick={() => navigate('manager')}>一覧に戻る</button><p>口頭で受けた希望を入力します。提出後、本人向けの確認通知を作成します。</p></div>}
        <div className={styles.heading}><div><p className={styles.eyebrow}>テスト食堂</p><h1>{trial.stage === 'published' ? '自分のシフト' : '勤務希望を提出'}</h1><p className={styles.periodTitle}>{period.label}</p></div><label className={styles.personSelect}>試すスタッフ<select value={personId} onChange={e => { if (proxy) startProxy(e.target.value); else { setPersonId(e.target.value); setError(''); setFeedback(''); } }}>{trial.people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label></div>
        {trial.stage !== 'published' ? <>
          <section className={styles.profileCard}><div className={styles.sectionTitle}><h2>普段の働き方</h2><button disabled={!canEdit} className={styles.textButton} onClick={() => { setEditingBaseline(structuredClone(person.baseline)); setError(''); profileDialog.current?.showModal(); }}>変更する</button></div>
            <strong>{person.baseline.kind === 'fixed' ? person.baseline.weekdays.slice().sort().map(d => WEEKDAYS[d]).join('・') + '曜日' : '毎回、入れる日を選ぶ'}</strong>
            {person.baseline.kind === 'fixed' && <span className={styles.profileTime}>{person.baseline.start}〜{person.baseline.nextDay ? '翌' : ''}{person.baseline.end}</span>}
            <p>{person.baseline.targetUnit === 'week' ? '週' : '月'}{person.baseline.target}日程度、働きたい</p>
          </section>
          <section className={styles.calendarCard}><div className={styles.sectionTitle}><h2>今回の勤務希望</h2><span className={person.submitted && !dirty ? styles.done : styles.draft}>{person.submitted ? dirty ? '変更あり・再提出前' : '提出済み' : '未提出'}</span></div>
            <p className={styles.help}>{person.baseline.kind === 'fixed' ? '変えたい日を押してください。変更がなくても、そのまま提出できます。' : '入れる日や休みの希望がある日を押してください。空白の日は「未登録」のまま届きます。'}</p>
            <div className={styles.legend}><span><i className={styles.availableDot} />入れる</span><span><i className={styles.wantDot} />入りたい</span><span><i className={styles.restDot} />休み希望</span><span><i className={styles.offDot} />入れない</span></div>
            <div className={styles.calendar} aria-label="勤務希望カレンダー">
              {WEEKDAYS.map(d => <div className={styles.weekday} key={d}>{d}</div>)}
              {Array.from({ length: dayOfWeek(dates[0]) }, (_, i) => <div key={`blank-${i}`} />)}
              {dates.map(date => { const day = effectiveDay(person.baseline, person.draft, date); return <button key={date} type="button" className={`${styles.day} ${styles[day.status]}`} disabled={!canEdit} aria-label={`${dateLabel(date)} ${DAY_LABELS[day.status]} ${timeLabel(day)}`} onClick={() => openDay(date)}><b>{Number(date.slice(8))}</b><span>{shortLabels[day.status]}</span><small>{day.start || '—'}</small>{person.draft[date] && <i className={styles.changedMark} aria-label="今回変更した日" />}</button>; })}
            </div>
            <p className={styles.help}>「入れる・入りたい」は希望です。出勤日はシフト公開後に確認できます。</p>
          </section>
          {Object.keys(person.draft).length > 0 && <section className={styles.card}><h2>今回の変更</h2><ul className={styles.changeList}>{Object.entries(person.draft).sort(([a], [b]) => a.localeCompare(b)).map(([date, day]) => <li key={date}><strong>{dateLabel(date)}</strong><span>{DAY_LABELS[day.status]}<small>{timeLabel(day)}</small></span><button className={styles.textButton} disabled={!canEdit} onClick={() => openDay(date)}>修正</button></li>)}</ul></section>}
          <section className={styles.submitPanel}><p>提出締切：{period.deadline}</p><button className={styles.primary} disabled={!canEdit || (person.submitted !== null && !dirty)} onClick={() => dispatch({ type: 'submit', personId, proxy }, proxy ? '代理入力した希望を提出しました。本人向け通知も確認できます。' : '希望を提出しました。締切までは修正して再提出できます。')}>{!canEdit ? '受付を締め切りました' : person.submitted && !dirty ? '提出済みです' : person.submitted ? '変更した希望を再提出する' : proxy ? '代理入力した希望を提出する' : '希望を提出する'}</button><small>{!canEdit ? '変更がある場合は管理者へご相談ください。' : '入力内容は、提出すると管理者の一覧に反映されます。'}</small></section>
        </> : <>
          <section className={styles.card}><div className={styles.sectionTitle}><h2>出勤予定</h2><span className={styles.done}>{selfAssigned.length}日</span></div>{selfAssigned.length ? <ul className={styles.scheduleList}>{selfAssigned.map(date => <li key={date}><strong>{dateLabel(date)}</strong><span>{timeLabel(trial.assignments[date][personId])}</span></li>)}</ul> : <p className={styles.help}>この期間の出勤予定はありません。</p>}<p className={styles.help}>変更が必要な日は、下のボタンから管理者へ依頼できます。</p><div className={styles.inlineFields}><label>変更を希望する日<select value={selectedDate} onChange={e => setSelectedDate(e.target.value)}>{dates.map(date => <option value={date} key={date}>{dateLabel(date)}</option>)}</select></label><button className={styles.secondary} onClick={() => openDay(selectedDate)}>変更を依頼する</button></div></section>
          {trial.changes.filter(c => c.personId === personId).length > 0 && <section className={styles.card}><h2>変更依頼の状況</h2><ul className={styles.changeList}>{trial.changes.filter(c => c.personId === personId).map(c => <li key={c.id}><strong>{dateLabel(c.date)}</strong><span>{DAY_LABELS[c.day.status]}<small>{timeLabel(c.day)}</small></span><span>{c.status === 'pending' ? '確認待ち' : c.status === 'approved' ? '承認済み' : '見送り'}</span></li>)}</ul></section>}
        </>}
        <section className={styles.card}><h2>自分へのお知らせ <small className={styles.muted}>通知の再現</small></h2><div className={styles.inbox}>{visibleNotices.slice(0, 3).map(n => <article key={n.id}><strong>{n.kind}</strong><p>{n.text}</p></article>)}</div></section>
      </>}

      {screen === 'manager' && <>
        <div className={styles.heading}><div><p className={styles.eyebrow}>テスト食堂・管理者</p><h1>希望を確認する</h1><p className={styles.periodTitle}>{period.label}</p></div><span className={styles.submissionCount}><b>{submittedCount}</b> / {trial.people.length}<small>提出済み</small></span></div>
        <section className={styles.card}><div className={styles.sectionTitle}><h2>スタッフの提出状況</h2><span className={styles.muted}>締切 {period.deadline}</span></div><div className={styles.peopleList}>{trial.people.map(p => <article key={p.id}><div><strong>{p.name}</strong><p>{p.submitted ? `${p.submitted.baseline.targetUnit === 'week' ? '週' : '月'}${p.submitted.baseline.target}日程度を希望` : '勤務可能な日はまだ確認できません'}</p>{p.submitted?.proxy && <small>管理者が代理入力・第{p.submitted.version}版</small>}</div><span className={p.submitted ? styles.done : styles.draft}>{p.submitted ? '提出済み' : '未提出'}</span>{trial.stage !== 'published' && <button className={styles.secondary} onClick={() => startProxy(p.id)}>代理入力</button>}</article>)}</div></section>
        {pendingChanges.length > 0 && <section className={styles.card}><h2>公開後の変更依頼</h2><div className={styles.requests}>{pendingChanges.map(c => <article key={c.id}><strong>{trial.people.find(p => p.id === c.personId)?.name} · {dateLabel(c.date)}</strong><p>{DAY_LABELS[c.day.status]} {timeLabel(c.day)}</p><small>{['off', 'rest'].includes(c.day.status) ? '承認すると、この日の出勤予定から外れます。' : '承認すると、この時間で出勤予定を更新します。'}</small><div className={styles.actions}><button className={styles.secondary} onClick={() => dispatch({ type: 'resolve', id: c.id, approve: false }, '見送りを記録し、本人向け通知を作成しました。')}>今回は見送る</button><button className={styles.primary} onClick={() => dispatch({ type: 'resolve', id: c.id, approve: true }, '変更を承認し、出勤予定へ反映しました。')}>承認して反映</button></div></article>)}</div></section>}
        <section className={styles.card}><div className={styles.sectionTitle}><h2>{trial.stage === 'published' ? '公開したシフト' : '日ごとに確認・配置'}</h2><span className={styles.muted}>予定 {assignedTotal}件</span></div><p className={styles.help}>提出済みの希望だけを表示しています。人数は目安です。教育などの増員もそのまま配置できます。</p>
          <div className={styles.inlineFields}><label>確認する日<select value={selectedDate} onChange={e => { setSelectedDate(e.target.value); setError(''); }}>{dates.map(date => <option value={date} key={date}>{dateLabel(date)}</option>)}</select></label><label>人数の目安<input type="number" min={0} max={49} disabled={trial.stage === 'published'} value={need} onChange={e => dispatch({ type: 'need', date: selectedDate, count: Number(e.target.value) })} /></label></div>
          <div className={styles.staffing}><strong>{selectedCount}人を配置 / 目安 {need}人</strong><span>{selectedCount < need ? `あと${need - selectedCount}人分の調整` : selectedCount > need ? `目安より${selectedCount - need}人多い配置` : '目安の人数です'}</span></div><p className={styles.help}>人数はその日全体の人数です。勤務時間の重なりや担当業務も確認してください。</p>
          <div className={styles.candidates}>{trial.people.map(p => { const day = submittedDay(p, selectedDate); const assigned = selectedAssigned[p.id]; return <article key={p.id}><div><strong>{p.name}</strong><span className={`${styles.statusPill} ${styles[day.status]}`}>{p.submitted ? DAY_LABELS[day.status] : '未提出'}</span><p>{trial.stage === 'published' ? assigned ? `出勤予定 ${timeLabel(assigned)}` : '出勤予定なし' : timeLabel(day) || '勤務可能な時間は未確認'}</p></div>{trial.stage !== 'published' && <button className={assigned ? styles.assignedButton : styles.secondary} disabled={!assigned && !['available', 'want', 'rest'].includes(day.status)} onClick={() => assign(p.id)}>{assigned ? '配置済み・外す' : day.status === 'rest' ? '相談して配置' : 'この時間で配置'}</button>}</article>; })}</div>
          {trial.stage === 'closed' && <div className={styles.publishPanel}><p>全日程の配置を確認してから公開してください。未提出者や目安との過不足があっても、管理者の判断で公開できます。</p><button className={styles.primary} onClick={publish}>シフトを確定・公開する</button></div>}
          {trial.stage === 'collecting' && <p className={styles.help}>下の「時間を進めて試す」で締切後へ進むと、配置したシフトを公開できます。</p>}
        </section>
        <section className={styles.card}><h2>期間全体の出勤予定</h2><p className={styles.help}>配置した日と時間をまとめて確認できます。</p>{assignedTotal ? <ul className={styles.planOverview}>{dates.filter(date => Object.keys(trial.assignments[date] || {}).length).map(date => <li key={date}><button className={styles.textButton} onClick={() => { setSelectedDate(date); setFeedback(`${dateLabel(date)}を選びました。上の日別欄で確認できます。`); }}>{dateLabel(date)}</button><div>{Object.entries(trial.assignments[date]).map(([id, slot]) => <p key={id}>{trial.people.find(p => p.id === id)?.name}<span>{timeLabel(slot)}</span></p>)}</div></li>)}</ul> : <p className={styles.help}>まだ出勤予定を配置していません。</p>}</section>
      </>}

      {screen === 'notices' && <><div className={styles.heading}><div><p className={styles.eyebrow}>テスト食堂</p><h1>通知を確認する</h1><p className={styles.periodTitle}>{period.label}</p></div></div><p className={styles.help}>LINEへ届く内容を再現しています。実際の送信・到着・既読は検証していません。</p><NoticePanel key={mode} trial={trial} onOpen={id => { if (id === 'manager') navigate('manager'); else { setPersonId(id); navigate('staff'); } }} /></>}

      <details className={styles.testControls}><summary>時間を進めて試す・最初からやり直す</summary><p>テスト用に時間の経過を再現します。月単位と週単位のデータは別々です。</p><div className={styles.actions}><button disabled={trial.stage !== 'collecting'} onClick={() => dispatch({ type: 'remind' }, '未提出者への催促を再現しました。各スタッフ・各募集期間で1回だけ作成します。')}>締切前日に進む（催促）</button><button disabled={trial.stage !== 'collecting'} onClick={() => dispatch({ type: 'close' }, '受付を締め切りました。管理者画面で配置を確認・公開できます。')}>締切後に進む</button><button onClick={() => { if (window.confirm('この期間のテスト入力を消して、最初からやり直しますか？')) { setWorkspaces(prev => ({ ...prev, [mode]: createTrial(mode) })); navigate('staff'); setPersonId('a'); } }}>この期間をリセット</button></div><small>催促予定：{period.reminder} ／ 締切：{period.deadline}</small></details>
      <footer className={styles.footer}>ONOGAMI シフト · 希望収集テスト v0.1</footer>
    </div>

    <dialog ref={dayDialog} className={styles.dialog} aria-labelledby="day-dialog-title" onCancel={() => setError('')}><form onSubmit={saveDay}><div className={styles.sectionTitle}><h2 id="day-dialog-title">{dateLabel(selectedDate)}の{trial.stage === 'published' ? '変更依頼' : '希望'}</h2><button type="button" className={styles.closeButton} aria-label="閉じる" onClick={() => { dayDialog.current?.close(); setError(''); }}>×</button></div>
      {trial.stage === 'published' && <p className={styles.help}>管理者が承認するまで、出勤予定は変わりません。</p>}
      <fieldset className={styles.dayChoices}><legend>この日はどうしますか？</legend>
        {trial.stage !== 'published' && <label><input type="radio" name="day-status" checked={useDefault} onChange={() => setUseDefault(true)} /><span>普段の条件に戻す<small>{person.baseline.kind === 'fixed' && person.baseline.weekdays.includes(dayOfWeek(selectedDate)) ? `${person.baseline.start}〜${person.baseline.end}に入れる` : 'この日は未登録になります'}</small></span></label>}
        {(['off', 'rest', 'available', 'want'] as const).map(status => <label key={status}><input type="radio" name="day-status" checked={!useDefault && editingDay.status === status} onChange={() => { setUseDefault(false); setEditingDay(prev => ({ ...prev, status })); }} /><span>{DAY_LABELS[status]}<small>{status === 'off' ? '勤務できない日' : status === 'rest' ? 'できるだけ休みにしてほしい' : status === 'want' ? '優先して働きたい日' : '勤務できる日・時間'}</small></span></label>)}
      </fieldset>
      {!useDefault && editingDay.status !== 'off' && <div className={styles.timeBox}>{editingDay.status === 'rest' && <p className={styles.help}>相談された場合に入れる時間</p>}{renderTimeFields(editingDay, setEditingDay)}</div>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      <button className={styles.primary} type="submit">{trial.stage === 'published' ? '管理者に変更を依頼する' : 'この内容を下書きに反映'}</button>
    </form></dialog>

    <dialog ref={profileDialog} className={styles.dialog} aria-labelledby="profile-dialog-title" onCancel={() => setError('')}><form onSubmit={saveBaseline}><div className={styles.sectionTitle}><h2 id="profile-dialog-title">普段の働き方</h2><button type="button" className={styles.closeButton} aria-label="閉じる" onClick={() => { profileDialog.current?.close(); setError(''); }}>×</button></div>{editingBaseline && <>
      <label className={styles.formLabel}>勤務可能な日の決め方<select value={editingBaseline.kind} onChange={e => setEditingBaseline({ ...editingBaseline, kind: e.target.value as Baseline['kind'] })}><option value="fixed">普段入れる曜日・時間がある</option><option value="variable">毎回、入れる日を選ぶ</option></select></label>
      {editingBaseline.kind === 'fixed' && <><fieldset className={styles.weekdayChoices}><legend>普段入れる曜日</legend>{WEEKDAYS.map((day, index) => <label key={day}><input type="checkbox" checked={editingBaseline.weekdays.includes(index)} onChange={e => setEditingBaseline({ ...editingBaseline, weekdays: e.target.checked ? [...editingBaseline.weekdays, index].sort() : editingBaseline.weekdays.filter(d => d !== index) })} /><span>{day}</span></label>)}</fieldset>{renderTimeFields({ ...editingBaseline, status: 'available' }, day => setEditingBaseline({ ...editingBaseline, start: day.start!, end: day.end!, nextDay: !!day.nextDay }))}</>}
      <fieldset className={styles.targetFields}><legend>働きたい日数の目安</legend><div className={styles.inlineFields}><label>単位<select value={editingBaseline.targetUnit} onChange={e => setEditingBaseline({ ...editingBaseline, targetUnit: e.target.value as 'week' | 'month', target: Math.min(editingBaseline.target, e.target.value === 'week' ? 7 : 31) })}><option value="week">週あたり</option><option value="month">月あたり</option></select></label><label>日数<input type="number" required min={0} max={editingBaseline.targetUnit === 'week' ? 7 : 31} value={editingBaseline.target} onChange={e => setEditingBaseline({ ...editingBaseline, target: Number(e.target.value) })} /></label><span>日程度</span></div></fieldset><p className={styles.help}>管理者が調整するときの目安です。出勤日数を確約するものではありません。</p>
      {error && <p className={styles.error} role="alert">{error}</p>}<button className={styles.primary}>この条件で希望を確認する</button>
    </>}</form></dialog>
  </main>;
}

function NoticePanel({ trial, onOpen }: { trial: Trial; onOpen: (id: string) => void }) {
  const [recipientId, setRecipientId] = useState('');
  const [kind, setKind] = useState('');
  const [page, setPage] = useState(0);
  const pageSize = 10;
  const names = new Map(trial.people.map(person => [person.id, person.name]));
  names.set('manager', '管理者');
  const filtered = trial.notices.filter(notice => (!kind || notice.kind === kind) &&
    (!recipientId || notice.to === recipientId));
  const groups = new Map<string, { key: string; kind: string; text: string; notices: Trial['notices'] }>();
  for (const notice of filtered) {
    const key = JSON.stringify([notice.kind, notice.text]);
    const group = groups.get(key);
    if (group) group.notices.push(notice);
    else groups.set(key, { key, kind: notice.kind, text: notice.text, notices: [notice] });
  }
  const grouped = [...groups.values()];
  const pageCount = Math.max(1, Math.ceil(grouped.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const shown = grouped.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const hasFilters = !!recipientId || !!kind;

  return <section className={`${styles.card} ${styles.noticePanel}`} aria-label="通知一覧">
    <div className={styles.sectionTitle}><h2>通知一覧</h2><span className={styles.muted}>模擬通知</span></div>
    <p className={styles.help}>同じ内容をまとめています。行を開くと本文と宛先を確認できます。</p>
    <div className={styles.noticeFilters}>
      <label>名前<select value={recipientId} onChange={event => { setRecipientId(event.target.value); setPage(0); }}><option value="">全員</option>{[...names].map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select></label>
      <label>通知の種類<select value={kind} onChange={event => { setKind(event.target.value); setPage(0); }}><option value="">すべての種類</option>{[...new Set(trial.notices.map(notice => notice.kind))].map(value => <option value={value} key={value}>{value}</option>)}</select></label>
    </div>
    <div className={styles.noticeResults}><p role="status">{grouped.length}種類の内容 · 通知{filtered.length}件{hasFilters ? ` / 全${trial.notices.length}件` : ''}</p>{hasFilters && <button className={styles.textButton} onClick={() => { setRecipientId(''); setKind(''); setPage(0); }}>絞り込みを解除</button>}</div>
    {shown.length ? <div className={styles.noticeRows}>{shown.map(group => {
      const recipients = [...new Set(group.notices.map(notice => notice.to))];
      return <details className={styles.noticeGroup} key={group.key}>
        <summary><span className={styles.noticeSummary}><strong>{group.kind}</strong><span className={styles.noticeExcerpt}>{group.text}</span></span><span className={styles.noticeRecipientCount}>{recipients.length}宛先</span><span className={styles.noticeChevron} aria-hidden="true">⌄</span></summary>
        <div className={styles.noticeDetail}>
          <p>{group.text}</p>
          <div className={styles.noticeRecipientsHeading}><h3>宛先</h3><span>{recipients.length}宛先 · 通知{group.notices.length}件</span></div>
          <ul className={styles.noticeRecipients}>{recipients.map(id => <li key={id}><button onClick={() => onOpen(id)} aria-label={`${names.get(id) || '不明な宛先'}の画面を開く`}><span>{names.get(id) || '不明な宛先'}</span><span aria-hidden="true">画面を開く →</span></button></li>)}</ul>
        </div>
      </details>;
    })}</div> : <div className={styles.noticeEmpty}><strong>{hasFilters ? '条件に合う通知はありません' : 'この期間の通知はまだありません'}</strong><p>{hasFilters ? '名前や通知の種類を選び直してください。' : '希望提出や催促を試すと、ここで通知を確認できます。'}</p></div>}
    {pageCount > 1 && <nav className={styles.noticePagination} aria-label="通知一覧のページ"><button className={styles.secondary} disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>前の10件</button><span>{currentPage + 1} / {pageCount}ページ</span><button className={styles.secondary} disabled={currentPage === pageCount - 1} onClick={() => setPage(currentPage + 1)}>次の10件</button></nav>}
  </section>;
}
