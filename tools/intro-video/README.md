# Landing page intro video

Films `media/intro.mp4` / `media/intro.webm` with a fictional family ("The Riveras") and
a fake backend, so no real data is used. Re-run it whenever the app's look changes.

```sh
npm i -g playwright             # Chromium must be available
node mkphotos.js                # draws the stand-in "photos" (*.jpg)
node record.js                  # writes frames/ and frames.json
node -e 'const m=require("./frames.json"),fs=require("fs");let s="";m.forEach((f,i)=>{s+=`file frames/${f[0]}\nduration ${((m[i+1]||[0,f[1]+0.8])[1]-f[1]).toFixed(4)}\n`});s+=`file frames/${m[m.length-1][0]}\n`;fs.writeFileSync("list.txt",s)'
ffmpeg -f concat -safe 0 -i list.txt -vf "fps=30,scale=540:-2" -c:v libx264 -pix_fmt yuv420p -crf 29 -an -movflags +faststart ../../media/intro.mp4
ffmpeg -i ../../media/intro.mp4 -c:v libvpx-vp9 -b:v 0 -crf 40 -an ../../media/intro.webm
ffmpeg -ss 16.5 -i ../../media/intro.mp4 -frames:v 1 -q:v 4 ../../media/intro-poster.jpg
```
