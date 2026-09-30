// Software regression tests only. They check the engine behaves as specified on synthetic holes.
// They are NOT evidence of real-world accuracy (no field data has been compared yet).
const fs=require('fs'), E=require('../caddie-engine.js');
const {settings,fixtures}=JSON.parse(fs.readFileSync(__dirname+'/fixtures.json','utf8'));
const run=f=>{const H=E.buildHole({type:"FeatureCollection",features:f.features},1,"blue",{unmarkedLie:settings.unmarkedLie,corridor:settings.corridor});
  return E.makeCaddie(H,{seed:settings.seed,samples:settings.samples,treeH:settings.treeH,par:f.par}).planTee();};
const cmp=(a,op,b)=>op==="<="?a<=b:op===">="?a>=b:op===">"?a>b:op==="<"?a<b:a===b;
const rows=[]; let pass=0,fail=0;
for(const f of fixtures){
  const t0=Date.now(), p=run(f), secs=(Date.now()-t0)/1000, p2=run(f);
  const deterministic=JSON.stringify(p.strategies)===JSON.stringify(p2.strategies);
  const o=p.strategies.optimise;
  const results=[{check:"deterministic",ok:deterministic,detail:"same inputs twice give identical output"}];
  for(const x of f.expect){
    let ok,detail;
    if(x.check==="optimiseAim"){ok=cmp(o.best.off,x.op,x.value);detail=`aim ${o.best.off} m (${x.op} ${x.value})`;}
    else if(x.check==="optimiseCarry"){ok=cmp(o.best.club[1],x.op,x.value);detail=`${o.best.club[0]} ${o.best.club[1]} m (${x.op} ${x.value})`;}
    else if(x.check==="optimiseCorner"){ok=!!o.best.tgt===x.value;detail=o.best.tgt?"plays to the corner":"plays at the flag";}
    else if(x.check==="optimiseAverage"){ok=cmp(o.expected,x.op,x.value);detail=`average ${o.expected.toFixed(2)} (95% sampling ${o.uncertainty.confidence95.map(v=>v.toFixed(2)).join("-")}) ${x.op} ${x.value}`;}
    else if(x.check==="styleConsistent"){const s=p.strategies[x.style],v=s.verdict;
      if(!v.chosen){ok=JSON.stringify(s.best)===JSON.stringify(p.strategies.optimise.best)||p.strategies.optimise.verdict.reason.includes(x.style);detail=v.reason;}
      else{const c=v.costChange,g=v.goalChange;ok=c.mean<=0.3&&(x.style==="safe"?g.mean<-1.96*g.se:g.mean>1.96*g.se);detail=v.reason;}}
    results.push({check:x.check+(x.style?`:${x.style}`:""),ok,detail,why:x.why});
  }
  results.forEach(r=>r.ok?pass++:fail++);
  rows.push({id:f.id,about:f.about,seconds:secs,samples:settings.samples,seed:settings.seed,
    strategies:Object.fromEntries(Object.entries(p.strategies).map(([k,s])=>[k,{first:`${s.best.club[0]} ${s.best.tgt?"corner":s.best.off+" m"}`,
      average:+s.expected.toFixed(3),ci95:s.uncertainty.confidence95.map(v=>+v.toFixed(3)),pBirdie:s.pBirdie,pDouble:s.pDouble,chosen:s.verdict.chosen,reason:s.verdict.reason,nearTie:s.comparison?!s.comparison.distinguishable:null,versus:s.comparison&&s.comparison.versus}])),results});
}
fs.writeFileSync(__dirname+'/acceptance-results.json',JSON.stringify({kind:"software regression, synthetic holes",settings,pass,fail,rows},null,1));
let md=`# Acceptance results (software regression only)\n\nSynthetic holes, seed ${settings.seed}, ${settings.samples} simulated trials per option. These check that the engine behaves as specified. **They are not evidence of real-world accuracy.** Intervals are simulation sampling noise only.\n\n**${pass} passed, ${fail} failed.**\n`;
for(const r of rows){md+=`\n## ${r.id}\n${r.about} (${r.seconds.toFixed(1)} s)\n\n| Strategy | First shot | Average (95% sampling) | Birdie+ | Double+ | Used? |\n|---|---|---|---|---|---|\n`;
  for(const [k,s] of Object.entries(r.strategies))md+=`| ${k} | ${s.first} | ${s.average.toFixed(2)} (${s.ci95.join("–")}) | ${s.pBirdie==null?"–":Math.round(100*s.pBirdie)+"%"} | ${s.pDouble==null?"–":Math.round(100*s.pDouble)+"%"} | ${s.chosen?"yes":"= Optimise"}${s.nearTie?` (near-tie with ${s.versus})`:""} |\n`;
  md+=`\n`;for(const x of r.results)md+=`- ${x.ok?"PASS":"FAIL"} — ${x.check}: ${x.detail}${x.why?` *(${x.why})*`:""}\n`;}
fs.writeFileSync(__dirname+'/acceptance-results.md',md);
console.log(`${pass} passed, ${fail} failed`);
for(const r of rows)console.log(`${r.id.padEnd(16)} ${r.seconds.toFixed(1)}s  `+Object.entries(r.strategies).map(([k,s])=>`${k[0].toUpperCase()}:${s.first} ${s.average.toFixed(2)}${s.chosen?"":"(=O)"}`).join(" | ")+"  "+r.results.filter(x=>!x.ok).map(x=>"FAIL "+x.check).join(" "));
