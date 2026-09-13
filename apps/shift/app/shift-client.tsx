'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import type { Member } from '@shared/shift-connected.mjs';
import ShiftWorkspace,{type Call} from './shift-workspace';
import styles from '@trial-style';

export default function ShiftClient({liffId}:{liffId:string}){
  const [members,setMembers]=useState<Member[]|null>(null);
  const [error,setError]=useState('');
  const [loginRequired,setLoginRequired]=useState(false);
  const sdk=useRef<typeof import('@line/liff').default|null>(null);
  const init=useRef<Promise<void>|null>(null);
  const call:Call=useCallback(async(action,input={},storeId='')=>{
    const idToken=sdk.current?.getIDToken();
    if(!idToken)throw new Error('LINEにログインし直してください。');
    let response:Response;
    try{response=await fetch('/api/requests',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${idToken}`},body:JSON.stringify({action,input,storeId}),cache:'no-store'});}
    catch{throw new Error('接続できませんでした。入力を残したまま、時間をおいてお試しください。');}
    const result=await response.json();
    if(!result.ok)throw Object.assign(new Error(result.message||'接続できませんでした。'),{code:result.code});
    return result.data;
  },[]);
  useEffect(()=>{
    let active=true;
    init.current ||= import('@line/liff').then(async({default:liff})=>{sdk.current=liff;await liff.init({liffId});});
    void init.current.then(async()=>{
      if(!active)return;
      if(!sdk.current?.isLoggedIn()){setLoginRequired(true);return;}
      const result=await call('memberships');if(active)setMembers(result as Member[]);
    }).catch(()=>{if(active)setError('LINEとの接続を確認できませんでした。もう一度画面を開いてください。');});
    return()=>{active=false;};
  },[liffId,call]);
  if(members)return <ShiftWorkspace members={members} call={call}/>;
  return <main className={styles.page}><div className={styles.shell}><header className={styles.header}><strong>ONOGAMI シフト</strong></header><section className={styles.card}><h1>勤務希望の提出と確認</h1>{error?<p role="alert">{error}</p>:loginRequired?<><p>LINEに登録済みの店舗で利用できます。</p><button className={styles.primary} onClick={()=>sdk.current?.login({redirectUri:window.location.origin+'/'})}>LINEでログインする</button></>:<p role="status">LINEの登録情報を確認しています…</p>}</section></div></main>;
}
