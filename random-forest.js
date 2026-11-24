"use strict";

// Random Forest regressor leggero, senza dipendenze native.
// Le feature di ogni riga sono calcolate esclusivamente con match precedenti.
function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function finished(match) {
  const status = String(match.status || match.state || "").toLowerCase();
  return ["finished", "played", "ft", "full_time", "completed"].includes(status) ||
    (number(match.home_goals) !== null && number(match.away_goals) !== null);
}
function dateOf(match) { return match.match_date || match.date || null; }
function teamSample(history, name, beforeDate, venue) {
  const target = String(name || "").trim().toLowerCase();
  return history.filter(m => {
    const d = dateOf(m);
    if (!d || new Date(d) >= new Date(beforeDate) || !finished(m) ||
        number(m.home_goals) === null || number(m.away_goals) === null) return false;
    const home = String(m.home_team || "").trim().toLowerCase();
    const away = String(m.away_team || "").trim().toLowerCase();
    if (venue === "home") return home === target;
    if (venue === "away") return away === target;
    return home === target || away === target;
  }).sort((a,b) => new Date(dateOf(b)) - new Date(dateOf(a))).slice(0, 10);
}
function weighted(rows, selector) {
  let sum = 0, weights = 0;
  rows.forEach((m,i) => { const v=selector(m); if(v===null)return; const w=Math.pow(0.75,i); sum+=v*w; weights+=w; });
  return weights ? sum/weights : 0;
}
function features(history, homeName, awayName, beforeDate) {
  const h=teamSample(history,homeName,beforeDate);
  const a=teamSample(history,awayName,beforeDate);
  const hv=teamSample(history,homeName,beforeDate,"home");
  const av=teamSample(history,awayName,beforeDate,"away");
  const league=history.filter(m=>dateOf(m)&&new Date(dateOf(m))<new Date(beforeDate)&&finished(m)&&number(m.home_goals)!==null&&number(m.away_goals)!==null).slice(-300);
  const avg=(rows,key)=>rows.length?rows.reduce((s,m)=>s+number(m[key]),0)/rows.length:0;
  const hFor=weighted(h,m=>String(m.home_team||"").toLowerCase()===String(homeName).toLowerCase()?number(m.home_goals):number(m.away_goals));
  const hAgainst=weighted(h,m=>String(m.home_team||"").toLowerCase()===String(homeName).toLowerCase()?number(m.away_goals):number(m.home_goals));
  const aFor=weighted(a,m=>String(m.home_team||"").toLowerCase()===String(awayName).toLowerCase()?number(m.home_goals):number(m.away_goals));
  const aAgainst=weighted(a,m=>String(m.home_team||"").toLowerCase()===String(awayName).toLowerCase()?number(m.away_goals):number(m.home_goals));
  return [hFor,hAgainst,aFor,aAgainst,avg(league,"home_goals"),avg(league,"away_goals"),
    hv.length?weighted(hv,m=>number(m.home_goals)):hFor,
    av.length?weighted(av,m=>number(m.away_goals)):aFor,
    h.length,a.length];
}
function rng(seed) {
  let x=seed>>>0;
  return () => { x=(1664525*x+1013904223)>>>0; return x/4294967296; };
}
function mse(rows, feature, threshold) {
  let left=0,right=0,ln=0,rn=0;
  for(const row of rows){if(row.x[feature]<=threshold){left+=row.y;ln++;}else{right+=row.y;rn++;}}
  if(!ln||!rn)return Infinity;
  const lm=left/ln,rm=right/rn;
  let error=0;
  for(const row of rows){const d=row.y-(row.x[feature]<=threshold?lm:rm);error+=d*d;}
  return error;
}
function mean(rows) { return rows.reduce((s,r)=>s+r.y,0)/Math.max(1,rows.length); }
function buildTree(rows, depth, random, featureCount) {
  const prediction=mean(rows);
  if(depth<=0||rows.length<12)return {value:prediction};
  const indexes=Array.from({length:featureCount},(_,i)=>i).sort(()=>random()-0.5).slice(0,Math.max(2,Math.ceil(Math.sqrt(featureCount))));
  let best=null;
  for(const feature of indexes){
    const values=[...new Set(rows.map(r=>r.x[feature]))].sort((a,b)=>a-b);
    if(values.length<2)continue;
    const candidates=values.length>8?Array.from({length:7},(_,i)=>values[Math.floor((i+1)*values.length/8)]):values.slice(0,-1);
    for(const threshold of candidates){const error=mse(rows,feature,threshold);if(!best||error<best.error)best={feature,threshold,error};}
  }
  if(!best||!Number.isFinite(best.error))return {value:prediction};
  const left=rows.filter(r=>r.x[best.feature]<=best.threshold),right=rows.filter(r=>r.x[best.feature]>best.threshold);
  if(left.length<5||right.length<5)return {value:prediction};
  return {feature:best.feature,threshold:best.threshold,left:buildTree(left,depth-1,random,featureCount),right:buildTree(right,depth-1,random,featureCount)};
}
function predictTree(tree,x){while(tree.feature!==undefined)tree=x[tree.feature]<=tree.threshold?tree.left:tree.right;return tree.value;}
function trainForest(rows,seed) {
  const random=rng(seed),trees=[];
  for(let t=0;t<35;t++){
    const sample=Array.from({length:rows.length},()=>rows[Math.floor(random()*rows.length)]);
    trees.push(buildTree(sample,4,random,rows[0].x.length));
  }
  return x=>trees.reduce((s,tree)=>s+predictTree(tree,x),0)/trees.length;
}
function predictRandomForest(history, fixture) {
  const targetDate=dateOf(fixture);
  const homeName=fixture.home_team,awayName=fixture.away_team;
  if(!targetDate||!homeName||!awayName)return {applied:false,reason:"Dati fixture incompleti"};
  const prior=history.filter(m=>dateOf(m)&&new Date(dateOf(m))<new Date(targetDate)&&finished(m)&&number(m.home_goals)!==null&&number(m.away_goals)!==null)
    .sort((a,b)=>new Date(dateOf(a))-new Date(dateOf(b))).slice(-500);
  const rows=[];
  for(const match of prior){
    const x=features(history,match.home_team,match.away_team,dateOf(match));
    if(x.every(Number.isFinite))rows.push({x,home:number(match.home_goals),away:number(match.away_goals)});
  }
  if(rows.length<80)return {applied:false,training_matches:rows.length,reason:"Servono almeno 80 partite storiche per addestrare il Random Forest"};
  const homeRows=rows.map(r=>({x:r.x,y:r.home})),awayRows=rows.map(r=>({x:r.x,y:r.away}));
  const current=features(history,homeName,awayName,targetDate);
  const homePredict=trainForest(homeRows,20261124)(current);
  const awayPredict=trainForest(awayRows,20261125)(current);
  return {applied:true,training_matches:rows.length,home:Math.max(0.1,Math.min(4.5,homePredict)),away:Math.max(0.1,Math.min(4.5,awayPredict)),trees:35,max_depth:4};
}
module.exports={predictRandomForest};
