"use strict";

const KEY = "nexttask_pwa_v2";
const WAKE = "__WAKE__";
const SLEEP = "__SLEEP__";
const MAX_HISTORY = 3;
const DECAY_HALF_LIFE_DAYS = 30;
const DECAY_HALF_LIFE_MS = DECAY_HALF_LIFE_DAYS * 24 * 60 * 60 * 1000;

const baseTasks = [
  ["bottle","ペットボトルを捨てる",2],
  ["trash","ゴミ袋をまとめる",2],
  ["desk","机の上を片付ける",2],
  ["bath","風呂に入る",3],
  ["rest","10分休憩する",1],
];

function makeTask(id,name,priority){
  return {id,name,priority,selected:0,completed:0,skipped:0,deferred:0,lastSelected:0,context:{}};
}

function freshState(){
  return {
    version:3,
    tasks:baseTasks.map(([id,name,priority])=>makeTask(id,name,priority)),
    currentId:null,
    currentStartedAt:null,
    recentHistory:[],
    ngrams:{"1":{},"2":{},"3":{}},
    cycleActive:true,
    cycleNumber:1,
    cycleStartedAt:Date.now(),
    lastSleepAt:null,
    lastWakeAt:null,
    wakeCount:0,
    sleepCount:0,
    totalSelections:0,
    totalCompletes:0,
    totalSkips:0,
    totalDeferred:0,
    viewOffset:0
  };
}

function migrate(saved){
  if(!saved || !Array.isArray(saved.tasks)) return freshState();
  if(saved.version===3){
    saved.ngrams ||= {"1":{},"2":{},"3":{}};
    saved.recentHistory ||= [];
    saved.cycleActive = saved.cycleActive !== false;
    saved.cycleNumber ||= 1;
    saved.wakeCount ||= 0;
    saved.sleepCount ||= 0;
    saved.tasks.forEach(t=>{
      t.context ||= {};
      t.deferred ||= 0;
    });
    return saved;
  }
  const s=freshState();
  s.tasks=saved.tasks.map(t=>({...makeTask(t.id,t.name,t.priority||2),...t,context:t.context||{}}));
  s.currentId=saved.currentId||null;
  s.currentStartedAt=saved.currentStartedAt||null;
  s.totalSelections=saved.totalSelections||0;
  s.totalCompletes=saved.totalCompletes||0;
  s.totalSkips=saved.totalSkips||0;
  s.totalDeferred=saved.totalDeferred||0;
  s.viewOffset=saved.viewOffset||0;
  if(saved.previousCompletedId) s.recentHistory=[saved.previousCompletedId];
  if(saved.transitions) s.ngrams["1"]=saved.transitions;
  return s;
}

function loadState(){
  try{
    return migrate(JSON.parse(localStorage.getItem(KEY)));
  }catch(e){
    return freshState();
  }
}

let state=loadState();

function saveState(){
  localStorage.setItem(KEY,JSON.stringify(state));
  render();
}

function nowContext(){
  const d=new Date(),h=d.getHours();
  const bucket=h<6?"深夜":h<11?"朝":h<15?"昼":h<19?"夕方":"夜";
  return {bucket,weekend:[0,6].includes(d.getDay())};
}
function ctxKey(ctx){return `${ctx.weekend?"休日":"平日"}-${ctx.bucket}`;}
function getTask(id){return state.tasks.find(t=>t.id===id);}
function ensureCtx(t,key){
  if(!t.context[key]) t.context[key]={selected:0,completed:0,skipped:0};
  return t.context[key];
}
function smoothRate(success,total){return (success+1)/(total+2);}

function timeDecayFrom(ts){
  if(!ts) return 1;
  const age=Math.max(0,Date.now()-ts);
  return Math.pow(0.5,age/DECAY_HALF_LIFE_MS);
}

function completionRate(t){
  const raw=smoothRate(t.completed,t.selected);
  const d=timeDecayFrom(t.lastSelected);
  return 0.5+(raw-0.5)*d;
}

function historyKey(arr){return arr.join(">");}

function decayedCell(cell,now=Date.now()){
  if(typeof cell==="number") return cell;
  if(!cell || typeof cell.w!=="number") return 0;
  const ts=typeof cell.t==="number"?cell.t:now;
  const age=Math.max(0,now-ts);
  return cell.w*Math.pow(0.5,age/DECAY_HALF_LIFE_MS);
}

function bumpCell(cell,amount=1){
  const now=Date.now();
  return {w:decayedCell(cell,now)+amount,t:now};
}

function appendHistory(token){
  state.recentHistory.push(token);
  if(state.recentHistory.length>MAX_HISTORY) state.recentHistory=state.recentHistory.slice(-MAX_HISTORY);
}

function recordNgrams(nextId){
  const h=state.recentHistory;
  for(let n=1;n<=Math.min(MAX_HISTORY,h.length);n++){
    const ctx=historyKey(h.slice(-n));
    const table=state.ngrams[String(n)];
    if(!table[ctx]) table[ctx]={};
    table[ctx][nextId]=bumpCell(table[ctx][nextId],1);
  }
}

function ngramInfo(nextId){
  const h=state.recentHistory;
  const vocab=Math.max(2,state.tasks.length);
  const parts=[];
  for(let n=Math.min(MAX_HISTORY,h.length);n>=1;n--){
    const ctx=historyKey(h.slice(-n));
    const row=state.ngrams[String(n)][ctx];
    if(!row) continue;
    const now=Date.now();
    const total=Object.values(row).reduce((a,b)=>a+decayedCell(b,now),0);
    if(!total) continue;
    const count=decayedCell(row[nextId],now);
    const p=(count+0.5)/(total+0.5*vocab);
    const confidence=total/(total+2+n*2);
    const weight=n*confidence;
    parts.push({n,total,p,weight,count});
  }
  if(!parts.length) return {score:1/vocab,level:0,total:0,count:0};
  const denom=parts.reduce((a,x)=>a+x.weight,0);
  const score=parts.reduce((a,x)=>a+x.p*x.weight,0)/denom;
  const best=parts[0];
  return {score,level:best.n,total:best.total,count:best.count};
}

function contextRate(t,key){
  const c=t.context[key];
  if(!c||c.selected===0) return 0.5;
  const raw=smoothRate(c.completed,c.selected);
  const d=timeDecayFrom(t.lastSelected);
  return 0.5+(raw-0.5)*d;
}
function novelty(t){
  if(!t.lastSelected) return 1;
  return Math.min(1,(Date.now()-t.lastSelected)/(1000*60*60*12));
}
function utility(t){
  const ctx=ctxKey(nowContext());
  const comp=completionRate(t);
  const ng=ngramInfo(t.id).score;
  const contextual=contextRate(t,ctx);
  const priority=t.priority/3;
  const novel=novelty(t);
  const penalty=Math.min(0.35,(t.skipped+t.deferred)*0.025)*timeDecayFrom(t.lastSelected);
  return 1.35*comp + 2.10*ng + 0.80*contextual + 0.65*priority + 0.28*novel - penalty;
}

function ranked(){
  if(!state.cycleActive) return [];
  const available=state.tasks.filter(t=>t.id!==state.currentId);
  if(!available.length) return [];
  const us=available.map(t=>({t,u:utility(t),ng:ngramInfo(t.id)}));
  const temp=0.72;
  const maxU=Math.max(...us.map(x=>x.u));
  const exps=us.map(x=>Math.exp((x.u-maxU)/temp));
  const sum=exps.reduce((a,b)=>a+b,0);
  return us.map((x,i)=>({...x,p:exps[i]/sum})).sort((a,b)=>b.u-a.u);
}

function reasons(t){
  const out=[];
  const ng=ngramInfo(t.id);
  const ctx=ctxKey(nowContext());
  if(ng.level>=3 && ng.count>0) out.push("4-gram一致");
  else if(ng.level===2 && ng.count>0) out.push("3-gram一致");
  else if(ng.level===1 && ng.count>0) out.push("2-gram一致");
  if(t.selected>=2&&completionRate(t)>=0.65) out.push("完了しやすい");
  const c=t.context[ctx];
  if(c&&c.selected>=2&&contextRate(t,ctx)>=0.65) out.push(`${ctx}に相性◎`);
  if(t.priority===3) out.push("優先度 高");
  if(!out.length) out.push("学習中");
  return out.slice(0,3);
}

function selectTask(id){
  if(!state.cycleActive){toast("起床を押してサイクルを開始してください");return;}
  const t=getTask(id);if(!t)return;
  t.selected++;t.lastSelected=Date.now();state.totalSelections++;
  ensureCtx(t,ctxKey(nowContext())).selected++;
  state.currentId=id;state.currentStartedAt=Date.now();state.viewOffset=0;
  saveState();toast("開始しました");
}

function completeCurrent(){
  const t=getTask(state.currentId);if(!t)return;
  t.completed++;state.totalCompletes++;
  ensureCtx(t,ctxKey(nowContext())).completed++;
  recordNgrams(t.id);
  appendHistory(t.id);
  state.currentId=null;state.currentStartedAt=null;
  saveState();toast("完了を学習しました ✓");
}

function skipCurrent(){
  const t=getTask(state.currentId);if(!t)return;
  t.skipped++;state.totalSkips++;
  ensureCtx(t,ctxKey(nowContext())).skipped++;
  state.currentId=null;state.currentStartedAt=null;
  saveState();toast("スキップを学習しました");
}

function deferTask(id){
  const t=getTask(id);if(!t)return;
  t.deferred++;state.totalDeferred++;
  t.lastSelected=Date.now();
  saveState();toast("あと回しを学習しました");
}

function markWake(){
  if(state.cycleActive)return;
  state.cycleActive=true;
  state.cycleNumber++;
  state.cycleStartedAt=Date.now();
  state.lastWakeAt=Date.now();
  state.wakeCount++;
  state.recentHistory=[WAKE];
  state.viewOffset=0;
  saveState();
  toast("起床：新しいサイクルを開始しました ☀️");
}

function markSleep(){
  if(!state.cycleActive)return;
  if(state.currentId){
    toast("実行中タスクを完了かスキップしてから就寝してください");
    return;
  }
  recordNgrams(SLEEP);
  state.cycleActive=false;
  state.lastSleepAt=Date.now();
  state.sleepCount++;
  state.recentHistory=[];
  state.viewOffset=0;
  saveState();
  toast("就寝：このサイクルを終了しました 🌙");
}

function addTask(name,priority=2){
  name=(name||"").trim();if(!name)return false;
  state.tasks.push(makeTask("t_"+Date.now()+"_"+Math.random().toString(36).slice(2,7),name,Number(priority)||2));
  saveState();return true;
}

function normalizeBulkLine(line){
  let s=(line||"").trim();
  if(!s) return null;

  s=s
    .replace(/^[-*•・]\s+/, "")
    .replace(/^\d+[.)、]\s*/, "")
    .replace(/^[□☐☑✓✔]\s*/, "")
    .trim();

  let priority=2;
  const high=/^(?:\[高\]|【高】|高[:：]|🔴)\s*/;
  const mid=/^(?:\[中\]|【中】|中[:：]|🟡)\s*/;
  const low=/^(?:\[低\]|【低】|低[:：]|🟢)\s*/;

  if(high.test(s)){priority=3;s=s.replace(high,"").trim();}
  else if(low.test(s)){priority=1;s=s.replace(low,"").trim();}
  else if(mid.test(s)){priority=2;s=s.replace(mid,"").trim();}

  s=s.replace(/^[-–—]\s*/, "").trim();
  if(!s) return null;
  if(s.length>60) s=s.slice(0,60).trim();
  return {name:s,priority};
}

function bulkAddTasks(text){
  const parsed=String(text||"")
    .split(/\r?\n/)
    .map(normalizeBulkLine)
    .filter(Boolean);

  if(!parsed.length) return {added:0,duplicates:0};

  const existing=new Set(state.tasks.map(t=>t.name.trim().toLocaleLowerCase("ja-JP")));
  let added=0,duplicates=0;

  for(const item of parsed){
    const key=item.name.trim().toLocaleLowerCase("ja-JP");
    if(existing.has(key)){
      duplicates++;
      continue;
    }
    state.tasks.push(makeTask(
      "t_"+Date.now()+"_"+Math.random().toString(36).slice(2,8),
      item.name,
      item.priority
    ));
    existing.add(key);
    added++;
  }

  if(added) saveState();
  return {added,duplicates};
}

function aiBulkPrompt(){
  return [
    "NextTaskというタスクアプリに一括登録したいです。",
    "私がやるべきタスクを、1行1タスクで一覧にしてください。",
    "説明文や見出しは不要です。",
    "優先度が高いものは [高]、普通は [中]、低いものは [低] を先頭につけてください。",
    "例:",
    "[高] 風呂に入る",
    "[中] ゴミを捨てる",
    "[低] 本を10分読む"
  ].join("\n");
}

function deleteTask(id){
  if(state.currentId===id)state.currentId=null;
  state.tasks=state.tasks.filter(t=>t.id!==id);
  state.recentHistory=state.recentHistory.filter(x=>x!==id);
  for(const table of Object.values(state.ngrams)){
    for(const row of Object.values(table)) delete row[id];
  }
  saveState();
}

function esc(s){
  return String(s).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));
}

function renderCards(){
  const box=document.getElementById("cards");
  const more=document.getElementById("showMoreBtn");
  if(!state.cycleActive){
    box.innerHTML='<div class="sleeping"><strong>🌙 就寝サイクル中</strong>「☀️ 起床」を押すと履歴を新しいサイクルとして開始します。<br>前日の行動列とはつながりません。</div>';
    more.classList.add("hidden");
    return;
  }
  more.classList.remove("hidden");
  const r=ranked();
  if(!r.length){
    box.innerHTML='<div class="insight">タスクを追加してください。</div>';
    return;
  }
  const start=state.viewOffset%Math.max(1,r.length);
  const ordered=[...r.slice(start),...r.slice(0,start)];
  const shown=ordered.slice(0,Math.min(3,ordered.length));
  box.innerHTML=shown.map((x,i)=>`
    <article class="card">
      <div class="card-top">
        <div>
          <div class="rank">#${i+1}</div>
          <div class="task-name">${esc(x.t.name)}</div>
        </div>
        <div class="prob">${Math.round(x.p*100)}%<small>予測</small></div>
      </div>
      <div class="reason">${reasons(x.t).map(v=>`<span class="chip ${v.includes("gram")?"ngram":""}">${esc(v)}</span>`).join("")}</div>
      <div class="card-actions">
        <button class="start-btn" data-start="${x.t.id}">これをやる</button>
        <button class="defer-btn" data-defer="${x.t.id}">あとで</button>
      </div>
    </article>`).join("");
  box.querySelectorAll("[data-start]").forEach(b=>b.addEventListener("click",()=>selectTask(b.dataset.start)));
  box.querySelectorAll("[data-defer]").forEach(b=>b.addEventListener("click",()=>deferTask(b.dataset.defer)));
}

function renderRunning(){
  const t=getTask(state.currentId);
  const box=document.getElementById("runningCard");
  if(!t){box.classList.add("hidden");return;}
  box.classList.remove("hidden");
  document.getElementById("runningName").textContent=t.name;
  const min=state.currentStartedAt?Math.floor((Date.now()-state.currentStartedAt)/60000):0;
  document.getElementById("runningMeta").textContent=min>0?`開始から約 ${min} 分`:"始めたばかり";
}

function renderCycle(){
  const status=document.getElementById("cycleStatus");
  const detail=document.getElementById("cycleDetail");
  const wake=document.getElementById("wakeBtn");
  const sleep=document.getElementById("sleepBtn");
  if(state.cycleActive){
    status.textContent="活動中";
    const n=state.recentHistory.filter(x=>x!==WAKE&&x!==SLEEP).length;
    detail.textContent=`第${state.cycleNumber}サイクル・直近${n}行動を保持`;
    wake.disabled=true;
    sleep.disabled=false;
  }else{
    status.textContent="就寝中";
    detail.textContent="履歴を切断して待機中";
    wake.disabled=false;
    sleep.disabled=true;
  }
}

function renderTaskList(){
  const box=document.getElementById("taskList");
  if(!state.tasks.length){box.innerHTML='<div class="insight">タスクがありません。</div>';return;}
  box.innerHTML=state.tasks.map(t=>`
    <div class="task-row">
      <div><b>${esc(t.name)}</b><small>選択 ${t.selected} / 完了 ${t.completed} / あとで ${t.deferred}</small></div>
      <button type="button" data-delete="${t.id}">削除</button>
    </div>`).join("");
  box.querySelectorAll("[data-delete]").forEach(b=>b.addEventListener("click",()=>{
    if(confirm("このタスクを削除しますか？"))deleteTask(b.dataset.delete);
  }));
}

function strongestNgram(){
  for(let n=3;n>=1;n--){
    const ctx=state.recentHistory.slice(-n);
    if(ctx.length<n)continue;
    const row=state.ngrams[String(n)][historyKey(ctx)];
    if(!row)continue;
    const now=Date.now();
    const total=Object.values(row).reduce((a,b)=>a+decayedCell(b,now),0);
    if(total>0.01)return {n,total};
  }
  return {n:0,total:0};
}

function bestInsight(){
  if(!state.cycleActive)return "就寝で履歴を切り、起床から新しい行動列として学習します。";
  if(state.totalCompletes<3)return "完了した行動列が増えると、1個前→2個前→3個前の順に文脈を深く使います。";
  const best=[...state.tasks].filter(t=>t.selected>0).sort((a,b)=>completionRate(b)-completionRate(a))[0];
  if(!best)return "学習中です。";
  return `今のところ「${best.name}」は完了率 ${Math.round(completionRate(best)*100)}% です。`;
}

function render(){
  const ctx=nowContext();
  document.getElementById("contextLabel").textContent=`${ctx.weekend?"休日":"平日"}・${ctx.bucket}`;
  document.getElementById("learningCount").textContent=state.totalSelections;
  document.getElementById("mSelections").textContent=state.totalSelections;
  document.getElementById("mCompletes").textContent=state.totalCompletes;
  document.getElementById("mSkips").textContent=state.totalSkips;
  const ng=strongestNgram();
  document.getElementById("ngramStatus").textContent=ng.n
    ? `🧠 最大 ${ng.n+1}-gram 利用中・古い習慣は${DECAY_HALF_LIFE_DAYS}日で半減`
    : `🧠 可変N-gram学習中・古い習慣は${DECAY_HALF_LIFE_DAYS}日で半減`;
  document.getElementById("learnInsight").textContent=bestInsight();
  renderCycle();renderRunning();renderCards();renderTaskList();
}

function toast(msg){
  const t=document.getElementById("toast");
  t.textContent=msg;t.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer=setTimeout(()=>t.classList.add("hidden"),1600);
}

document.getElementById("completeBtn").addEventListener("click",completeCurrent);
document.getElementById("skipBtn").addEventListener("click",skipCurrent);
document.getElementById("wakeBtn").addEventListener("click",markWake);
document.getElementById("sleepBtn").addEventListener("click",markSleep);

document.getElementById("showMoreBtn").addEventListener("click",()=>{
  state.viewOffset=(state.viewOffset+3)%Math.max(1,ranked().length);
  renderCards();
});
document.getElementById("quickAddBtn").addEventListener("click",()=>{
  const i=document.getElementById("quickTask");
  if(addTask(i.value,2)){i.value="";toast("タスクを追加しました");}
});
document.getElementById("quickTask").addEventListener("keydown",e=>{
  if(e.key==="Enter")document.getElementById("quickAddBtn").click();
});

const dialog=document.getElementById("settingsDialog");
document.getElementById("settingsBtn").addEventListener("click",()=>dialog.showModal());
document.getElementById("addTaskBtn").addEventListener("click",()=>{
  const name=document.getElementById("taskName");
  const pri=document.getElementById("taskPriority");
  if(addTask(name.value,pri.value)){name.value="";toast("タスクを追加しました");}
});
document.getElementById("importBulkBtn").addEventListener("click",()=>{
  const area=document.getElementById("bulkTasks");
  const result=bulkAddTasks(area.value);
  if(!result.added && !result.duplicates){
    toast("追加できるタスクがありません");
    return;
  }
  area.value="";
  const extra=result.duplicates?`・重複 \${result.duplicates}件を除外`:"";
  toast(`\${result.added}件追加しました\${extra}`);
});

document.getElementById("copyBulkPromptBtn").addEventListener("click",async()=>{
  const prompt=aiBulkPrompt();
  try{
    await navigator.clipboard.writeText(prompt);
    toast("AI用の依頼文をコピーしました");
  }catch(e){
    const area=document.getElementById("bulkTasks");
    area.value=prompt;
    area.focus();
    area.select();
    toast("依頼文を入力欄に入れました");
  }
});

document.getElementById("exportBtn").addEventListener("click",()=>{
  const blob=new Blob([JSON.stringify(state,null,2)],{type:"application/json"});
  const a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download="nexttask-data.json";
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
});
document.getElementById("resetBtn").addEventListener("click",()=>{
  if(confirm("すべての学習データを初期化しますか？")){
    state=freshState();
    localStorage.removeItem(KEY);
    saveState();
    toast("初期化しました");
  }
});

if("serviceWorker" in navigator){
  window.addEventListener("load",()=>navigator.serviceWorker.register("./sw.js").catch(()=>{}));
}
render();
