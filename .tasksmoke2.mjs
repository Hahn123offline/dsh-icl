import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
const out = path.resolve('C:/DSH/icl/.state/lab/mc-body-soak/task-semantics-smoke2'); fs.mkdirSync(out,{recursive:true})
const child = spawn(process.execPath, ['packages/mc-body/src/cli.mjs','--host','127.0.0.1','--port','54837','--listen','54905','--name','ICL-mcbody-smoke2','--allow-task','--state',path.join(out,'tasks.json'),'--log',path.join(out,'events.jsonl')], {stdio:['ignore','pipe','pipe'],cwd:process.cwd()})
let log=''; child.stdout.on('data',d=>log+=d); child.stderr.on('data',d=>log+=d)
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms)); const base='http://127.0.0.1:54905'
const get=async(p)=>(await fetch(base+p,{signal:AbortSignal.timeout(2000)})).json()
const post=async(p,b)=>(await fetch(base+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b??{})})).json()
let up=false, lastErr=''
for(let i=0;i<80;i++){try{const s=await get('/v1/status'); if(s.adapter?.spawnSafety){up=true;break}; lastErr='status-no-safety:'+JSON.stringify(s.paused)}catch(e){lastErr=e.message} if(child.exitCode!=null) break; await sleep(500)}
console.log('up',up,'exit',child.exitCode,'lastErr',lastErr); console.log('LOG:', log.split('\n').slice(0,6).join(' | '))
if (up) {
  async function waitTask(id, t=60000){ const start=Date.now(); while(Date.now()-start<t){ const r=await get('/v1/tasks/'+id); if(['done','failed','cancelled','interrupted','unknown'].includes(r.task?.state)) return r.task; await sleep(400) } return {timeout:true} }
  const mineDirt = await post('/v1/tasks',{kind:'mine',params:{block:'dirt',count:2,radius:8},deadlineMs:45000})
  const r2 = await waitTask(mineDirt.task.id)
  console.log('mine dirt ->', r2.state, r2.error, JSON.stringify(r2.result))
  const gotoReach = await post('/v1/tasks',{kind:'goto',params:{x:30,y:-60,z:-24,range:2},deadlineMs:30000})
  const r4 = await waitTask(gotoReach.task.id)
  console.log('goto reachable ->', r4.state, r4.error, JSON.stringify(r4.result))
  await post('/v1/shutdown',{reason:'task-semantics2-done'})
}
for(let i=0;i<40 && child.exitCode==null;i++) await sleep(250)
console.log('final exitCode', child.exitCode)
console.log('key events:', log.split('\n').filter(l=>/task_failed|task_done|path_precheck|exit reason|body_error/.test(l)).slice(-8).join('\n'))
