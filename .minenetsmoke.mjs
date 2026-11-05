import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
const out = path.resolve('C:/DSH/icl/.state/lab/mc-body-soak/mine-net-smoke'); fs.mkdirSync(out,{recursive:true})
const child = spawn(process.execPath, ['packages/mc-body/src/cli.mjs','--host','127.0.0.1','--port','54839','--listen','54902','--name','ICL-mcbody-t9','--allow-task','--paused-disconnect-ms','0','--state',path.join(out,'tasks.json'),'--log',path.join(out,'events.jsonl')], {stdio:['ignore','pipe','pipe'],cwd:process.cwd()})
let log=''; child.stdout.on('data',d=>log+=d); child.stderr.on('data',d=>log+=d)
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms)); const base='http://127.0.0.1:54902'
const get=async(p)=>(await fetch(base+p,{signal:AbortSignal.timeout(3000)})).json()
const post=async(p,b,t=120000)=>(await fetch(base+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b??{}),signal:AbortSignal.timeout(t)})).json()
let up=false; for(let i=0;i<90;i++){try{const s=await get('/v1/status'); if(s.adapter?.spawnSafety){up=true;break}}catch{} if(child.exitCode!=null) break; await sleep(500)}
console.log('up',up)
if (up) {
  const inv=async()=>{const r=await post('/v1/inspect',{kind:'inventory'}); return (r.result?.data?.items??[]).filter(x=>x.name==='dirt').reduce((s,x)=>s+x.count,0)}
  const before=await inv()
  const r=await post('/v1/do',{steps:[{op:'mine',params:{block:'dirt',count:3,radius:8}}]},120000)
  const after=await inv()
  console.log('mine dirt3 ->', JSON.stringify(r.results?.[0]?.result ?? r.error), 'dirt', before, '->', after)
  await post('/v1/shutdown',{reason:'mine-net-smoke-done'}).catch(()=>null)
}
for(let i=0;i<40 && child.exitCode==null;i++) await sleep(250)
const rec = fs.existsSync(path.join(out,'body-exit.json')) ? JSON.parse(fs.readFileSync(path.join(out,'body-exit.json'))) : null
console.log('exit', child.exitCode, rec?.reason)
