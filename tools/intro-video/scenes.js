// Illustrated stand-in "family photos" for the marketing video (no real people).
const scenes = {
ship: {tone:'sepia(.85) contrast(1.05)', svg:`
<rect width="800" height="600" fill="#cfe3ee"/><circle cx="620" cy="140" r="60" fill="#fff4c9"/>
<g fill="#8aa5b5"><rect x="40" y="250" width="50" height="130"/><rect x="100" y="210" width="40" height="170"/><rect x="150" y="270" width="60" height="110"/><rect x="225" y="190" width="30" height="190"/><rect x="232" y="160" width="16" height="30"/><rect x="265" y="240" width="55" height="140"/></g>
<rect y="380" width="800" height="220" fill="#5d8aa3"/>
<g fill="#2c3e50"><path d="M330 400 L720 400 L690 470 L360 470 Z"/><rect x="420" y="330" width="220" height="70" fill="#f2efe6"/><rect x="460" y="270" width="40" height="60" fill="#b23a3a"/><rect x="560" y="270" width="40" height="60" fill="#b23a3a"/></g>
<g fill="#2c3e50">${[440,470,500,530,560,590,620].map(x=>`<circle cx="${x}" cy="365" r="8"/>`).join('')}</g>
<g stroke="#fff" stroke-width="4" opacity=".6"><path d="M0 500 Q100 480 200 500 T400 500 T600 500 T800 500" fill="none"/><path d="M0 550 Q100 530 200 550 T400 550 T600 550 T800 550" fill="none"/></g>`},
bakery: {tone:'sepia(.9) contrast(1.05)', svg:`
<rect width="800" height="600" fill="#e9dcc3"/><rect x="120" y="120" width="560" height="440" fill="#b8865a"/>
<rect x="150" y="150" width="500" height="70" fill="#3b2a1e"/><text x="400" y="200" font-family="Georgia" font-size="44" fill="#f5e6c8" text-anchor="middle" letter-spacing="6">PANADERÍA</text>
<g>${[0,1,2,3,4,5,6,7,8,9].map(i=>`<rect x="${130+i*54}" y="230" width="27" height="50" fill="${i%2?'#f5f0e6':'#b23a3a'}"/>`).join('')}</g>
<path d="M130 280 Q157 300 184 280 Q211 300 238 280 Q265 300 292 280 Q319 300 346 280 Q373 300 400 280 Q427 300 454 280 Q481 300 508 280 Q535 300 562 280 Q589 300 616 280 Q643 300 670 280" fill="#b23a3a"/>
<rect x="170" y="320" width="220" height="180" fill="#f8efd8" stroke="#3b2a1e" stroke-width="8"/><rect x="450" y="320" width="150" height="240" fill="#5a3b25" stroke="#3b2a1e" stroke-width="8"/>
<g fill="#c98a3d"><ellipse cx="230" cy="470" rx="38" ry="20"/><ellipse cx="320" cy="470" rx="38" ry="20"/><ellipse cx="275" cy="430" rx="34" ry="18"/></g><rect y="560" width="800" height="40" fill="#9b9081"/>`},
wedding60: {tone:'grayscale(1) contrast(1.1)', svg:`
<rect width="800" height="600" fill="#ddd"/><path d="M250 600 L250 260 Q400 80 550 260 L550 600 Z" fill="#fff" stroke="#888" stroke-width="10"/>
<path d="M300 600 L300 290 Q400 160 500 290 L500 600 Z" fill="#6d6d6d"/>
<g fill="#fff">${Array.from({length:40},(_,i)=>`<circle cx="${(i*97)%800}" cy="${(i*53)%560}" r="${3+(i%4)}"/>`).join('')}</g>
<g><circle cx="365" cy="420" r="26" fill="#222"/><path d="M325 600 L340 450 L390 450 L405 600 Z" fill="#222"/><circle cx="440" cy="420" r="26" fill="#eee"/><path d="M395 600 L420 450 L460 450 L490 600 Z" fill="#fafafa"/></g>`},
wedding89: {tone:'saturate(.75) sepia(.25)', svg:`
<rect width="800" height="600" fill="#bfe1f0"/><rect y="420" width="800" height="180" fill="#7a7a7a"/><rect y="500" width="800" height="12" fill="#fff" opacity=".6"/>
<path d="M170 420 L200 330 L330 300 L470 300 L560 340 L640 360 L650 420 Z" fill="#f4f1ea"/><rect x="250" y="315" width="90" height="40" fill="#9fc6dc"/><rect x="360" y="315" width="90" height="40" fill="#9fc6dc"/>
<circle cx="260" cy="430" r="40" fill="#222"/><circle cx="560" cy="430" r="40" fill="#222"/><circle cx="260" cy="430" r="16" fill="#aaa"/><circle cx="560" cy="430" r="16" fill="#aaa"/>
<text x="420" y="395" font-family="Brush Script MT, cursive" font-size="40" fill="#d6336c" text-anchor="middle">Just Married</text>
<g stroke="#666" stroke-width="3">${[90,120,150].map((x,i)=>`<line x1="170" y1="${400+i*6}" x2="${x}" y2="${470+i*10}"/>`).join('')}</g><g fill="#999">${[90,120,150].map((x,i)=>`<rect x="${x-12}" y="${470+i*10}" width="24" height="30"/>`).join('')}</g>
<g>${['#ff6b6b','#ffd43b','#74c0fc','#b197fc'].map((c,i)=>`<circle cx="${560+i*45}" cy="${150+(i%2)*40}" r="30" fill="${c}"/><line x1="${560+i*45}" y1="${180+(i%2)*40}" x2="600" y2="330" stroke="#555" stroke-width="2"/>`).join('')}</g>`},
reunion: {tone:'saturate(1.1)', svg:`
<defs><linearGradient id="sk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffb37a"/><stop offset="1" stop-color="#ffe3b3"/></linearGradient></defs>
<rect width="800" height="600" fill="url(#sk)"/><circle cx="400" cy="330" r="110" fill="#ff8a4c"/><rect y="330" width="800" height="270" fill="#2f9fb8"/><path d="M0 470 Q400 420 800 470 L800 600 L0 600 Z" fill="#f3d9a4"/>
<g stroke="#5b3a1e" stroke-width="14" fill="none"><path d="M140 560 Q150 420 120 300"/><path d="M680 560 Q660 430 700 320"/></g>
<g fill="#2f7a3a">${[[120,300],[700,320]].map(([x,y])=>[0,60,120,180,240,300].map(a=>`<ellipse cx="${x+Math.cos(a*Math.PI/180)*55}" cy="${y+Math.sin(a*Math.PI/180)*22}" rx="62" ry="15" transform="rotate(${a} ${x+Math.cos(a*Math.PI/180)*55} ${y+Math.sin(a*Math.PI/180)*22})"/>`).join('')).join('')}</g>
<g>${['#7c3aed','#ff7a59','#d63a7a','#2b8a3e','#1971c2','#f59f00','#c2255c'].map((c,i)=>`<circle cx="${250+i*50}" cy="455" r="16" fill="#5b3a1e"/><rect x="${236+i*50}" y="472" width="28" height="55" rx="10" fill="${c}"/>`).join('')}</g>`},
cake: {tone:'saturate(1.05)', svg:`
<rect width="800" height="600" fill="#ffe8f0"/><g fill="#fff" opacity=".7">${Array.from({length:30},(_,i)=>`<circle cx="${(i*131)%800}" cy="${(i*71)%300}" r="${4+(i%5)}"/>`).join('')}</g>
<rect x="100" y="480" width="600" height="120" fill="#c48b5a"/><ellipse cx="400" cy="480" rx="260" ry="30" fill="#f1f3f5"/>
<rect x="230" y="330" width="340" height="150" rx="12" fill="#fff4e6"/><rect x="230" y="330" width="340" height="40" rx="12" fill="#f783ac"/>
<g fill="#f783ac">${[260,320,380,440,500].map(x=>`<circle cx="${x}" cy="372" r="12"/>`).join('')}</g>
<text x="400" y="450" font-family="Georgia" font-size="60" font-weight="bold" fill="#c2255c" text-anchor="middle">80</text>
<g>${[290,350,410,470,510].map(x=>`<rect x="${x}" y="270" width="12" height="60" fill="#74c0fc"/><path d="M${x+6} 240 Q${x+18} 258 ${x+6} 268 Q${x-6} 258 ${x+6} 240" fill="#ffa94d"/>`).join('')}</g>
<g>${['#ff6b6b','#ffd43b','#b197fc'].map((c,i)=>`<circle cx="${110+i*40}" cy="${170+i*30}" r="34" fill="${c}"/><circle cx="${690-i*40}" cy="${170+i*30}" r="34" fill="${c}"/>`).join('')}</g>`},
baby: {tone:'saturate(.9)', svg:`
<rect width="800" height="600" fill="#e7f5ff"/><rect y="440" width="800" height="160" fill="#d0bfa5"/>
<path d="M200 460 Q200 300 400 300 Q600 300 600 460 Z" fill="#fff"/><rect x="200" y="440" width="400" height="40" rx="18" fill="#a5d8ff"/>
<circle cx="400" cy="340" r="58" fill="#f4c7a1"/><path d="M345 330 Q400 260 455 330 Q440 300 400 296 Q360 300 345 330" fill="#7a4b2a"/>
<circle cx="380" cy="345" r="5" fill="#333"/><circle cx="420" cy="345" r="5" fill="#333"/><path d="M385 368 Q400 380 415 368" stroke="#333" stroke-width="4" fill="none"/>
<path d="M260 460 Q300 380 400 400 Q500 380 540 460 Z" fill="#ffd8a8"/><g fill="#ffd43b"><path d="M120 120 l12 30 32 2 -25 20 9 31 -28 -18 -28 18 9 -31 -25 -20 32 -2 Z"/><path d="M660 90 l9 22 24 2 -19 15 7 23 -21 -13 -21 13 7 -23 -19 -15 24 -2 Z"/></g>`},
};
module.exports = scenes;
