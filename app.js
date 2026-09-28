
"use strict";

const KEY = "nexttask_pwa_v2";
const BUCKETS = ["朝","昼","夕方","夜","深夜"];

const baseTasks = [
  ["bottle","ペットボトルを捨てる",2],
  ["trash","ゴミ袋をまとめる",2],
  ["desk","机の上を片付ける",2],
  ["bath","風呂に入る",3],
  ["rest","10分休憩する",1],
];

function freshState(){
  return {
    version:2,
    tasks: baseTasks.map(([id,name,priority])=>({
      id,name,priority,selected:0,completed:0,skipped:0,deferred:0,lastSelected:0,
      context:{}
    })),
    currentId:null,
    currentStartedAt:null,
    previousCompletedId:null,
    transitions:{},
    totalSelections:0,
    totalCompletes:0,
    totalSkips:0,
    totalDeferred:0,
    viewOffset:0
  };
}

let state = loadState();

function loadState(){
  try{
    const saved = JSON.parse(localStorage.getItem(KEY));
    if(saved && saved.version===2 && Array.isArray(saved.tasks)) return saved;
  }catch(e){}
  return freshState();
}
function saveState(){ localStorage.setItem(KEY, JSON.stringify(state)); render(); }
function nowContext(){
  const d = new Date(), h=d.getHours();
  let bucket = h<6?"深夜":h<11?"朝":h<15?"昼":h<19?"夕方":h<24?"夜":"深夜";
  return {bucket, weekend:[0,6].includes(d.getDay())};
}
function ctxKey(ctx){ return `${ctx.weekend?"休日":"平日"}-${ctx.bucket}`; }
function getTask(id){ return state.tasks.find(t=>t.id===id); }
function ensureCtx(t,key){
  if(!t.context[key]) t.context[key]={selected:0,completed:0,skipped:0};
  return t.context[key];
}
function smoothRate(success,total){ return (success+1)/(total+2); }
function completionRate(t){ return smoothRate(t.completed,t.selected); }

function transitionRate(fromId,toId){
  if(!fromId) return 0.5;
  const row=state.transitions[fromId]||{};
  const total=Object.values(row).reduce((a,b)=>a+b,0);
  return ((row[toId]||0)+1)/(total+Math.max(2,state.tasks.length));
}
function contextRate(t,key){
  const c=t.context[key];
  if(!c || c.selected===0) return 0.5;
  return smoothRate(c.completed,c.selected);
}
function novelty(t){
  if(!t.lastSelected) return 1;
  return Math.min(1,(Date.now()-t.lastSelected)/(1000*60*60*12));
}
function utility(t){
  const ctx=ctxKey(nowContext());
  const comp=completionRate(t);
  const trans=transitionRate(state.previousCompletedId,t.id);
  const contextual=contextRate(t,ctx);
  const priority=t.priority/3;
  const novel=novelty(t);
  const penalty=Math.min(0.35,(t.skipped+t.deferred)*0.025);
  return 1.45*comp + 1.15*trans + 0.85*contextual + 0.65*priority + 0.30*novel - penalty;
}
function ranked(){
  const available=state.tasks.filter(t=>t.id!==state.currentId);
  if(!available.length) return [];
  const us=available.map(t=>({t,u:utility(t)}));
  const temp=0.72;
  const maxU=Math.max(...us.map(x=>x.u));
  const exps=us.map(x=>Math.exp((x.u-maxU)/temp));
  const sum=exps.reduce((a,b)=>a+b,0);
  return us.map((x,i)=>({...x,p:exps[i]/sum})).sort((a,b)=>b.u-a.u);
}
function reasons(t){
  const out=[];
  const ctx=ctxKey(nowContext());
  if(t.selected>=2 && completionRate(t)>=0.65) out.push("完了しやすい");
  if(state.previousCompletedId && transitionRate(state.previousCompletedId,t.id)>.28) out.push("この流れで選びやすい");
  const c=t.context[ctx];
  if(c && c.selected>=2 && contextRate(t,ctx)>=0.65) out.push(`${ctx}に相性◎`);
  if(t.priority===3) out.push("優先度 高");
  if(!out.length) out.push("学習中");
  return out.slice(0,3);
}
function recordTransition(toId){
  const from=state.previousCompletedId;
  if(!from) return;
  if(!state.transitions[from]) state.transitions[from]={};
  state.transitions[from][toId]=(state.transitions[from][toId]||0)+1;
}
function selectTask(id){
  const t=getTask(id); if(!t) return;
  t.selected++; t.lastSelected=Date.now(); state.totalSelections++;
  const key=ctxKey(nowContext()); ensureCtx(t,key).selected++;
  recordTransition(id);
  state.currentId=id; state.currentStartedAt=Date.now();
  state.viewOffset=0;
  saveState();
  toast("開始しました");
}
function completeCurrent(){
  const t=getTask(state.currentId); if(!t) return;
  t.completed++; state.totalCompletes++;
  ensureCtx(t,ctxKey(nowContext())).completed++;
  state.previousCompletedId=t.id;
  state.currentId=null; state.currentStartedAt=null;
  saveState(); toast("完了を学習しました ✓");
}
function skipCurrent(){
  const t=getTask(state.currentId); if(!t) return;
  t.skipped++; state.totalSkips++;
  ensureCtx(t,ctxKey(nowContext())).skipped++;
  state.currentId=null; state.currentStartedAt=null;
  saveState(); toast("スキップを学習しました");
}
function deferTask(id){
  const t=getTask(id); if(!t) return;
  t.deferred++; state.totalDeferred++;
  t.lastSelected=Date.now();
  saveState(); toast("あと回しを学習しました");
}
function addTask(name,priority=2){
  name=(name||"").trim(); if(!name) return false;
  state.tasks.push({
    id:"t_"+Date.now()+"_"+Math.random().toString(36).slice(2,7),
    name,priority:Number(priority)||2,selected:0,completed:0,skipped:0,deferred:0,lastSelected:0,context:{}
  });
  saveState(); return true;
}
function deleteTask(id){
  if(state.currentId===id) state.currentId=null;
  if(state.previousCompletedId===id) state.previousCompletedId=null;
  state.tasks=state.tasks.filter(t=>t.id!==id);
  delete state.transitions[id];
  Object.values(state.transitions).forEach(row=>delete row[id]);
  saveState();
}
function esc(s){
  return String(s).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));
}
function renderCards(){
  const r=ranked();
  const box=document.getElementById("cards");
  if(!r.length){ box.innerHTML='<div class="insight">タスクを追加してください。</div>'; return; }
  const start=state.viewOffset % Math.max(1,r.length);
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
      <div class="reason">${reasons(x.t).map(v=>`<span class="chip">${esc(v)}</span>`).join("")}</div>
      <div class="card-actions">
        <button class="start-btn" data-start="${x.t.id}">これをやる</button>
        <button class="defer-btn" data-defer="${x.t.id}">あとで</button>
      </div>
    </article>
  `).join("");
  box.querySelectorAll("[data-start]").forEach(b=>b.addEventListener("click",()=>selectTask(b.dataset.start)));
  box.querySelectorAll("[data-defer]").forEach(b=>b.addEventListener("click",()=>deferTask(b.dataset.defer)));
}
function renderRunning(){
  const t=getTask(state.currentId);
  const box=document.getElementById("runningCard");
  if(!t){box.classList.add("hidden");return}
  box.classList.remove("hidden");
  document.getElementById("runningName").textContent=t.name;
  const min=state.currentStartedAt?Math.floor((Date.now()-state.currentStartedAt)/60000):0;
  document.getElementById("runningMeta").textContent=min>0?`開始から約 ${min} 分`:"始めたばかり";
}
function renderTaskList(){
  const box=document.getElementById("taskList");
  if(!state.tasks.length){box.innerHTML='<div class="insight">タスクがありません。</div>';return}
  box.innerHTML=state.tasks.map(t=>`
    <div class="task-row">
      <div><b>${esc(t.name)}</b><small>選択 ${t.selected} / 完了 ${t.completed} / あとで ${t.deferred}</small></div>
      <button type="button" data-delete="${t.id}">削除</button>
    </div>`).join("");
  box.querySelectorAll("[data-delete]").forEach(b=>b.addEventListener("click",()=>{
    if(confirm("このタスクを削除しますか？")) deleteTask(b.dataset.delete);
  }));
}
function bestInsight(){
  if(state.totalSelections<3) return "カードを何回か選と、よく選ぶ流れや時間帯の傾向を学習します。";
  const best=[...state.tasks].filter(t=>t.selected>0).sort((a,b)=>completionRate(b)-completionRate(a))[0];
  if(!best) return "学習中です。";
  const prev=getTask(state.previousCompletedId);
  if(prev){
    const row=state.transitions[prev.id]||{};
    const next=Object.entries(row).sort((a,b)=>b[1]-a[1])[0];
    const nt=next?getTask(next[0]):null;
    if(nt) return `「${prev.name}」の後は「${nt.name}」を選ぶ傾向があります。`;
  }
  return `今のところ「${best.name}」は完了率 ${Math.round(completionRate(best)*100)}% です。`;
}
function render(){
  const ctx=nowContext();
  document.getElementById("contextLabel").textContent=`${ctx.weekend?"休日":"平日"}・${ctx.bucket}`;
  document.getElementById("learningCount").textContent=state.totalSelections;
  document.getElementById("mSelections").textContent=state.totalSelections;
  document.getElementById("mCompletes").textContent=state.totalCompletes;
  document.getElementById("mSkips").textContent=state.totalSkips;
  document.getElementById("learnInsight").textContent=bestInsight();
  renderRunning(); renderCards(); renderTaskList();
}
function toast(msg){
  const t=document.getElementById("toast");
  t.textContent=msg; t.classList.remove("hidden");
  clearTimeout(toast.timer); toast.timer=setTimeout(()=>t.classList.add("hidden"),1500);
}

document.getElementById("completeBtn").addEventListener("click",completeCurrent);
document.getElementById("skipBtn").addEventListener("click",skipCurrent);
document.getElementById("showMoreBtn").addEventListener("click",()=>{
  state.viewOffset=(state.viewOffset+3)%Math.max(1,ranked().length); renderCards();
});
document.getElementById("quickAddBtn").addEventListener("click",()=>{
  const i=document.getElementById("quickTask");
  if(addTask(i.value,2)){i.value="";toast("タスクを追加しました")}
});
document.getElementById("quickTask").addEventListener("keydown",e=>{
  if(e.key==="Enter") document.getElementById("quickAddBtn").click();
});
const dialog=document.getElementById("settingsDialog");
document.getElementById("settingsBtn").addEventListener("click",()=>dialog.showModal());
document.getElementById("addTaskBtn").addEventListener("click",()=>{
  const name=document.getElementById("taskName"), pri=document.getElementById("taskPriority");
  if(addTask(name.value,pri.value)){name.value="";toast("タスクを追加しました")}
});
document.getElementById("exportBtn").addEventListener("click",()=>{
  const blob=new Blob([JSON.stringify(state,null,2)],{type:"application/json"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob);
  a.download="nexttask-data.json"; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
});
document.getElementById("resetBtn").addEventListener("click",()=>{
  if(confirm("すべての学習データを初期化しますか？")){
    state=freshState(); localStorage.removeItem(KEY); saveState(); toast("初期化しました");
  }
});

if("serviceWorker" in navigator){
  window.addEventListener("load",()=>navigator.serviceWorker.register("./sw.js").catch(()=>{}));
}
render();
