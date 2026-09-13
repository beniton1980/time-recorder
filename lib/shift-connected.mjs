export const EMPTY_SHIFT_PAYLOAD = { baseline: { kind:'variable',weekdays:[],start:'17:00',end:'22:00',nextDay:false,target:0,targetUnit:'week' }, days:{} };
export function periodDates(period) {
  const result=[];
  for(let d=new Date(period.starts_on+'T00:00:00Z'); d.toISOString().slice(0,10)<=period.ends_on && result.length<31; d.setUTCDate(d.getUTCDate()+1)) result.push(d.toISOString().slice(0,10));
  return result;
}
export function editorPayload(snapshot) { return structuredClone(snapshot.draft?.payload || snapshot.submitted?.payload || EMPTY_SHIFT_PAYLOAD); }
export function payloadEquals(a,b) {
  const canonical=v=>Array.isArray(v)?v.map(canonical):v && typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
  return JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
}
export function newPeriodInput(unit,start,deadline) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(deadline)) throw new Error('募集期間と締切を確認してください。');
  const end=new Date(start+'T00:00:00Z');
  if(unit==='month') { if(end.getUTCDate()!==1) throw new Error('月単位の開始日は1日を選んでください。'); end.setUTCMonth(end.getUTCMonth()+1,0); }
  else end.setUTCDate(end.getUTCDate()+6);
  return {unit,startsOn:start,endsOn:end.toISOString().slice(0,10),deadline:deadline+':00+09:00'};
}
