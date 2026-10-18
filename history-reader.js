(function(root){
'use strict';
const validDate=date=>typeof date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(date)&&Number.isFinite(Date.parse(date+'T00:00:00Z'))&&new Date(date+'T00:00:00Z').toISOString().slice(0,10)===date;
class HistoryReader {
 constructor({loadRecent,archiveBase='./archives',Fetch=root.fetch,Now=Date.now,onIndex=()=>{}}){Object.assign(this,{loadRecent,archiveBase:archiveBase.replace(/\/$/,''),Fetch,Now,onIndex});}
 async archive(date){
  // 缺少公開讀取出口時 404 代表未部署封存，不把它當成「資料已遺失」。
  const response=await this.Fetch(this.archiveBase+'/index.json',{cache:'no-cache',signal:AbortSignal.timeout(15000)});
  if(response.status===404)return null;
  if(!response.ok)throw Error('封存索引讀取失敗');
  const index=await response.json();
  if(index?.version!==1||!Array.isArray(index.days)||index.days.length>50000)throw Error('封存索引格式無效');
  const days=index.days.filter(day=>validDate(day?.date)&&Number.isSafeInteger(day.count)&&day.count>0&&day.count<=1440);
  this.onIndex(days);
  if(!days.some(day=>day.date===date))return null;
  const file=await this.Fetch(this.archiveBase+'/'+date+'.json.gz',{cache:'default',signal:AbortSignal.timeout(30000)});
  if(!file.ok)throw Error('封存檔案讀取失敗');
  if(Number(file.headers?.get('content-length'))>16000000)throw Error('封存壓縮檔過大');
  if(!root.DecompressionStream||!file.body)throw Error('此瀏覽器不支援壓縮歷史回放，請更新瀏覽器');
  const reader=file.body.pipeThrough(new root.DecompressionStream('gzip')).getReader(),chunks=[];let bytes=0;
  try{while(true){const item=await reader.read();if(item.done)break;bytes+=item.value.byteLength;if(bytes>60000000)throw Error('每日封存超過 60 MB');chunks.push(item.value);}}
  finally{await reader.cancel();}
  const data=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.byteLength;}
  const report=JSON.parse(new TextDecoder().decode(data));
  if(report?.kind!=='rf-battle-report'||report.version!==1||!Array.isArray(report.frames)||!report.frames.length||report.frames.length>1440)throw Error('封存格式無效');
  if(report.frames.some(f=>!Number.isFinite(Date.parse(f?.captured_at))||new Date(Date.parse(f.captured_at)+8*3600000).toISOString().slice(0,10)!==date))throw Error('封存日期不符');
  return report.frames;
 }
 async load(date){
  if(!validDate(date))throw Error('日期格式無效');
  const today=new Date(this.Now()+8*3600000).toISOString().slice(0,10);
  let archiveError;
  if(date<today){try{const frames=await this.archive(date);if(frames){this.source='archive';return frames;}}catch(error){archiveError=error;}}
  let frames,recentError;
  try{frames=await this.loadRecent(date);}catch(error){recentError=error;}
  if(frames?.length){this.source='cloud';return frames;}
  if(date>=today){try{const archived=await this.archive(date);if(archived){this.source='archive';return archived;}}catch(error){archiveError=error;}}
  if(recentError||archiveError)throw Error('近期歷史或封存讀取失敗，不能判定這一天沒有紀錄');
  this.source='empty';return [];
 }
}
root.RFHistoryReader=HistoryReader;
})(typeof window!=='undefined'?window:globalThis);
