'use client';
import {useEffect,useState,type FormEvent} from 'react';
import {newPeriodInput,type Member,type Period,type Snapshot,type RosterPerson} from '@shared/shift-connected.mjs';
import ShiftEditor from './shift-editor';
import styles from '@trial-style';
export type Call=(action:string,input?:Record<string,unknown>,storeId?:string)=>Promise<unknown>;
export default function ShiftWorkspace({members,call}:{members:Member[];call:Call}){
  const [storeId,setStoreId]=useState(members.length===1?members[0].storeId:'');
  const [periods,setPeriods]=useState<Period[]>([]);const [periodId,setPeriodId]=useState('');
  const [screen,setScreen]=useState<'self'|'manager'>('self');const [snapshot,setSnapshot]=useState<Snapshot|null>(null);
  const [people,setPeople]=useState<RosterPerson[]>([]);const [personId,setPersonId]=useState('');const [proxy,setProxy]=useState(false);
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [dirty,setDirty]=useState(false);const [generation,setGeneration]=useState(0);
  const [closeConfirmed,setCloseConfirmed]=useState(false);
  const [unit,setUnit]=useState<'month'|'week'>('month');const [start,setStart]=useState('');const [deadline,setDeadline]=useState('');
  const member=members.find(m=>m.storeId===storeId);const period=periods.find(p=>p.id===periodId);
  useEffect(()=>{if(!storeId)return;let active=true;
    void call('bootstrap',{},storeId).then(value=>{if(!active)return;const data=value as {periods:Period[]};setPeriods(data.periods);setPeriodId(data.periods[0]?.id||'');}).catch(caught=>{if(active)setError(caught.message);});
    return()=>{active=false;};
  },[storeId,call]);
  useEffect(()=>{if(!storeId||!periodId)return;let active=true;
    void call(screen==='self'?'self':'manager',{periodId},storeId).then(value=>{if(!active)return;if(screen==='self')setSnapshot(value as Snapshot);else{const data=value as {people:RosterPerson[]};setPeople(data.people);setPersonId('');} }).catch(caught=>{if(active)setError(caught.message);});
    return()=>{active=false;};
  },[storeId,periodId,screen,generation,call]);
  useEffect(()=>{if(!dirty)return;const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[dirty]);
  function canLeave(){if(busy){setError('保存が終わるまでお待ちください。');return false;}if(dirty){setError('入力中の変更があります。下書きを保存するか、提出してから切り替えてください。');return false;}return true;}
  function changeStore(id:string){if(!canLeave())return;setStoreId(id);setPeriods([]);setPeriodId('');setSnapshot(null);setPeople([]);setScreen('self');setProxy(false);setError('');}
  function changePeriod(id:string){if(!canLeave())return;setPeriodId(id);setSnapshot(null);setPeople([]);setProxy(false);setError('');}
  function changeScreen(next:'self'|'manager'){if(!canLeave())return;setScreen(next);setSnapshot(null);setPeople([]);setProxy(false);setError('');}
  function refresh(){setSnapshot(null);setPeople([]);setProxy(false);setDirty(false);setError('');setGeneration(v=>v+1);}
  async function createPeriod(e:FormEvent){e.preventDefault();if(busy)return;setBusy(true);setError('');try{const input=newPeriodInput(unit,start,deadline);const created=await call('createPeriod',{...input,id:crypto.randomUUID()},storeId) as Period;setPeriods(prev=>[created,...prev]);changePeriod(created.id);}catch(caught){setError(caught instanceof Error?caught.message:'作成できませんでした。');}finally{setBusy(false);}}
  async function closePeriod(){if(!period||busy||!closeConfirmed)return;setBusy(true);setError('');try{const closed=await call('closePeriod',{periodId,expectedVersion:period.version},storeId) as Period;setPeriods(prev=>prev.map(p=>p.id===closed.id?closed:p));setCloseConfirmed(false);refresh();}catch(caught){setError(caught instanceof Error?caught.message:'締め切れませんでした。');}finally{setBusy(false);}}
  const selected=people.find(p=>p.id===personId);
  return <main className={styles.page}><div className={styles.shell}>
    <header className={styles.header}><div><span className={styles.wordmark}>ONOGAMI</span><span className={styles.product}>シフト</span></div><span className={styles.trialBadge}>接続テスト版</span></header>
    {members.length===0?<section className={styles.card}><h1>利用できる店舗がありません</h1><p>登録済みのLINEアカウントかどうかを確認し、管理者へご相談ください。</p></section>:<>
      <div className={styles.inlineFields}><label>店舗<select value={storeId} onChange={e=>changeStore(e.target.value)}><option value="">店舗を選択</option>{members.map(m=><option key={m.storeId} value={m.storeId}>{m.storeName}</option>)}</select></label>{periods.length>0&&<label>募集期間<select value={periodId} onChange={e=>changePeriod(e.target.value)}>{periods.map(p=><option key={p.id} value={p.id}>{p.starts_on}〜{p.ends_on}（{p.unit==='month'?'月':'週'}単位）</option>)}</select></label>}</div>
      {member&&<><p className={styles.help}>{member.name}さん</p><nav className={styles.tabs} aria-label="シフトの操作"><button aria-current={screen==='self'?'page':undefined} onClick={()=>changeScreen('self')}>自分の希望</button>{member.manager&&<button aria-current={screen==='manager'?'page':undefined} onClick={()=>changeScreen('manager')}>管理者の確認</button>}</nav></>}
      {error&&<div role="alert" className={styles.error}>{error}</div>}
      {member?.manager&&<details className={styles.card}><summary>次の募集を作成する</summary><form onSubmit={createPeriod}><fieldset disabled={busy||dirty} style={{border:0,padding:0}}><div className={styles.inlineFields}><label>単位<select value={unit} onChange={e=>setUnit(e.target.value as 'month'|'week')}><option value="month">月単位</option><option value="week">週単位</option></select></label><label>開始日<input type="date" required value={start} onChange={e=>setStart(e.target.value)}/></label><label>提出締切（日本時間）<input type="datetime-local" required value={deadline} onChange={e=>setDeadline(e.target.value)}/></label></div><p className={styles.help}>月単位は1日から月末、週単位は開始日から7日間です。</p><button className={styles.primary}>{busy?'作成中…':'募集を作成する'}</button></fieldset></form></details>}
      {member&&!period&&<p className={styles.help}>募集期間がまだありません。管理者が募集を作成すると、希望を入力できます。</p>}
      {period&&screen==='self'&&(snapshot?<ShiftEditor key={`${storeId}:${periodId}:${generation}`} snapshot={snapshot} name={member?.name||''} call={(action,input)=>call(action,input,storeId)} onDirty={setDirty} onBusy={setBusy} reload={refresh}/>:<p role="status">希望を読み込んでいます…</p>)}
      {period&&screen==='manager'&&<>
        <div className={styles.heading}><h1>希望を確認する</h1><span>{people.filter(p=>p.submitted).length} / {people.length}人 提出済み</span></div>
        <section className={styles.card}><div className={styles.inlineFields}><label>確認するスタッフ<select value={personId} onChange={e=>{if(canLeave()){setPersonId(e.target.value);setProxy(false);setError('');}}}><option value="">全員の提出状況</option>{people.map(p=><option key={p.id} value={p.id}>{p.name}（{p.submitted?'提出済み':'未提出'}）</option>)}</select></label><button className={styles.secondary} disabled={dirty} onClick={refresh}>最新の状況を確認</button></div>
          {!selected&&<div className={styles.peopleList}>{people.map(p=><article key={p.id}><div><strong>{p.name}</strong><p>{p.submitted?`${p.submitted.proxy?'代理提出・':''}第${p.submitted.version}版`:'勤務可能な日はまだ確認できません'}</p></div><span className={p.submitted?styles.done:styles.draft}>{p.submitted?'提出済み':'未提出'}</span><button className={styles.secondary} onClick={()=>setPersonId(p.id)}>確認</button></article>)}</div>}
          {selected&&!proxy&&<div className={styles.actions}><button className={styles.secondary} onClick={()=>setProxy(true)}>口頭で受けた希望を代理入力</button></div>}
        </section>
        {selected&&<ShiftEditor key={`${selected.id}:${proxy}:${generation}`} snapshot={{period,draft:null,submitted:selected.submitted}} name={selected.name} proxyId={proxy?selected.id:undefined} readOnly={!proxy} onSubmitted={submitted=>setPeople(prev=>prev.map(p=>p.id===selected.id?{...p,submitted}:p))} call={(action,input)=>call(action,input,storeId)} onDirty={setDirty} onBusy={setBusy} reload={refresh}/>}
        {period.state==='collecting'&&!proxy&&<details className={styles.card}><summary>希望の受付を締め切る</summary><p className={styles.help}>締切後の変更は、管理者が本人に確認して代理入力します。</p><label className={styles.check}><input type="checkbox" checked={closeConfirmed} onChange={e=>setCloseConfirmed(e.target.checked)}/>受付を締め切ることを確認しました</label><button className={styles.secondary} disabled={!closeConfirmed||busy||dirty} onClick={()=>void closePeriod()}>受付を締め切る</button></details>}
        {!selected&&people.length===0&&<p role="status">提出状況を読み込んでいます…</p>}
      </>}
      <p className={styles.help}>現在は希望の保存・提出・確認を試せます。出勤予定の確定と通知送信は次の段階で接続します。</p>
    </>}
  </div></main>;
}
