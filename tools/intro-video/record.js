const { chromium } = require('playwright'); const fs = require('fs');
const path = require('path');
const HERE = __dirname, SITE = path.resolve(HERE, '../..'), FR = HERE + '/frames';
fs.rmSync(FR, { recursive: true, force: true }); fs.mkdirSync(FR);
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: false, colorScheme: 'light' });
  await ctx.route('**/*', r => { const u = new URL(r.request().url());
    if (u.hostname === 'cdn.jsdelivr.net') return r.fulfill({ path: HERE + '/fake-rec.js', contentType: 'text/javascript' });
    if (u.hostname === 'kt.test') {
      if (u.pathname.startsWith('/rec/')) return r.fulfill({ path: HERE + u.pathname.slice(4) });
      const f = u.pathname === '/' ? '/index.html' : u.pathname; return r.fulfill({ path: SITE + f }); }
    return r.abort(); });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.addInitScript(() => localStorage.setItem('ft_name', 'Lucy'));
  await p.goto('http://kt.test/');
  await p.addStyleTag({ content: `
    #joinOverlay, #toast, #welcomeBack { display:none !important; }
    #tap { position:fixed; z-index:9999; width:38px; height:38px; margin:-19px 0 0 -19px; border-radius:50%;
      background:rgba(255,255,255,.55); border:3px solid rgba(124,58,237,.75); box-shadow:0 4px 14px rgba(0,0,0,.18);
      left:330px; top:900px; transition:left .45s cubic-bezier(.3,.7,.3,1), top .45s cubic-bezier(.3,.7,.3,1), transform .15s; pointer-events:none; }
    #tap.down { transform:scale(.7); background:rgba(124,58,237,.35); }
    #cap { position:fixed; z-index:9998; left:50%; bottom:26px; transform:translate(-50%,12px); opacity:0; white-space:nowrap;
      background:rgba(30,16,60,.82); color:#fff; font:600 15px/1 system-ui,-apple-system,sans-serif; padding:11px 18px; border-radius:999px;
      transition:opacity .35s, transform .35s; pointer-events:none; }
    #cap.on { opacity:1; transform:translate(-50%,0); }` });
  await p.evaluate(() => { document.getElementById('timeline').innerHTML = '';
    document.body.insertAdjacentHTML('beforeend', '<div id="tap"></div><div id="cap"></div>'); });
  const cap = async t => { await p.evaluate(t => { const c = document.getElementById('cap'); c.classList.remove('on');
    setTimeout(() => { if (t) { c.textContent = t; c.classList.add('on'); } }, 250); }, t); };
  const tap = async (sel, opts = {}) => {
    const el = p.locator(sel).first(); await el.scrollIntoViewIfNeeded(); const bb = await el.boundingBox();
    await p.evaluate(([x, y]) => { const t = document.getElementById('tap'); t.style.left = x + 'px'; t.style.top = y + 'px'; }, [bb.x + bb.width / 2, bb.y + bb.height / 2]);
    await sleep(520); await p.evaluate(() => document.getElementById('tap').classList.add('down')); await sleep(140);
    await p.evaluate(() => document.getElementById('tap').classList.remove('down'));
    if (!opts.noclick) await el.click(); };
  const type = async (sel, text, d = 55) => { await tap(sel); await p.locator(sel).pressSequentially(text, { delay: d }); };

  const cdp = await ctx.newCDPSession(p); let n = 0; const meta = [];
  cdp.on('Page.screencastFrame', async f => { const name = String(n++).padStart(5, '0') + '.jpg';
    fs.writeFileSync(FR + '/' + name, Buffer.from(f.data, 'base64')); meta.push([name, f.metadata.timestamp]);
    try { await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch {} });

  await p.evaluate(() => openCreate());
  await sleep(300);
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: 780, maxHeight: 1688, everyNthFrame: 1 });
  await sleep(500);
  await cap("Start your family's timeline");
  await type('#newFamilyName', 'The Riveras', 70);
  await sleep(300); await tap('#createGoBtn'); await sleep(1700);
  await tap('#enterTimelineBtn'); await sleep(900);

  await cap('Add a memory in seconds');
  await tap('#addEntryBtn'); await sleep(500);
  await type('#fTitle', 'Grandma Rosa arrives in New York', 28);
  await tap('#fDate'); await p.fill('#fDate', '1958-06-14'); await sleep(300);
  await type('#fBody', 'She came by ship with one suitcase and her mother’s recipes.', 13);
  await tap('#fPhotos', { noclick: true }); await p.setInputFiles('#fPhotos', HERE + '/ship.jpg'); await sleep(400);
  await tap('#saveEntryBtn'); await sleep(1500);

  await cap('Your whole family adds theirs');
  await p.evaluate(() => { const t = document.getElementById('tap'); t.style.top = '1000px'; });
  const R = '/rec/';
  const waves = [
    [{ title: 'Tomás opens the bakery', entry_date: '1946-03-01', decade: '1940s', body: 'Pan dulce every morning at 5am.', created_by: 'Tío Luis', photos: [R + 'bakery.jpg'] },
     { title: 'Rosa and Tomás get married', entry_date: '1963-09-14', decade: '1960s', body: 'At St. Agnes, with the whole block invited.', created_by: 'Mom', photos: [R + 'wedding60.jpg'] }],
    [{ title: 'Mom is born in Brooklyn', entry_date: '1971-02-02', decade: '1970s', body: '', created_by: 'Mom' },
     { title: 'Road trip to the Grand Canyon', entry_date: null, decade: '1970s', body: 'Six of us in the station wagon.', created_by: 'Dad', uncertain_fields: ['date'] },
     { title: 'Mom and Dad’s wedding', entry_date: '1989-06-17', decade: '1980s', body: '', created_by: 'Dad', photos: [R + 'wedding89.jpg'] }],
    [{ title: 'Lucy’s first day of school', entry_date: '1995-09-05', decade: '1990s', body: '', created_by: 'Mom' },
     { title: 'Family reunion in San Juan', entry_date: '2008-07-04', decade: '2000s', body: '42 cousins, one beach.', created_by: 'Tío Luis', photos: [R + 'reunion.jpg'] },
     { title: 'Abuela Rosa turns 80', entry_date: '2019-11-30', decade: '2010s', body: '', created_by: 'Lucy', photos: [R + 'cake.jpg'] },
     { title: 'Baby Mateo joins the family', entry_date: '2024-04-12', decade: '2020s', body: '', created_by: 'Lucy', photos: [R + 'baby.jpg'] }],
  ];
  for (const w of waves) { await p.evaluate(w => window.__addRelatives(w), w); await sleep(1000); }
  await sleep(600);

  await cap('See your whole story, decade by decade');
  const H = await p.evaluate(() => document.documentElement.scrollHeight - innerHeight);
  await p.evaluate(H => new Promise(res => { const t0 = performance.now(), D = 6000;
    (function f(t) { const k = Math.min(1, (t - t0) / D); const e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      scrollTo(0, H * e); k < 1 ? requestAnimationFrame(f) : res(); })(t0); }), H);
  await sleep(500);
  await cap('');
  await tap('.entry-photos img >> nth=-2'); await p.evaluate(() => { document.getElementById('tap').style.opacity = 0; }); await sleep(2200);
  await cdp.send('Page.stopScreencast');
  fs.writeFileSync(HERE + '/frames.json', JSON.stringify(meta));
  console.log('frames', n, 'errors', errs, 'H', H);
  await b.close();
})();
