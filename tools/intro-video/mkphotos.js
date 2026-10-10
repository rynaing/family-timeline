const { chromium } = require('playwright'); const scenes = require('./scenes.js');
(async()=>{const b=await chromium.launch(); const p=await b.newPage({viewport:{width:800,height:600}});
for (const [k,s] of Object.entries(scenes)) {
  await p.setContent(`<style>body{margin:0}svg{display:block;filter:${s.tone}}.g{position:fixed;inset:0;background:radial-gradient(ellipse at center,transparent 55%,rgba(40,20,0,.35));}</style><svg width="800" height="600" viewBox="0 0 800 600">${s.svg}</svg><div class="g"></div>`);
  await p.screenshot({path:`${k}.jpg`, type:'jpeg', quality:85});
}
await b.close();})();
