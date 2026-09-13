import { shiftAppConfiguration } from '@shared/shift-http.mjs';
import ShiftClient from './shift-client';
import styles from '@trial-style';
export const dynamic='force-dynamic';
export default function Page(){
  let liffId:string;
  try{liffId=shiftAppConfiguration(process.env).liffId;}catch{return <main className={styles.page}><div className={styles.shell}><header className={styles.header}><strong>ONOGAMI シフト</strong></header><section className={styles.card}><h1>シフトの利用準備中です</h1><p>準備ができ次第、勤務希望を提出できるようになります。</p></section></div></main>;}
  return <ShiftClient liffId={liffId}/>;
}
