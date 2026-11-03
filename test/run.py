# Loads a copy of the extension pointed at localhost and runs it on a mock page.
# usage: python3 test/run.py <screenshots dir> <work dir>
import base64, http.server, json, os, shutil, subprocess, sys, threading, functools, glob, time
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
shots, work = sys.argv[1], sys.argv[2]
ext, site = f'{work}/ext', f'{work}/site'
shutil.rmtree(work, ignore_errors=True)
os.makedirs(site)
shutil.copytree(ROOT, ext, ignore=shutil.ignore_patterns('test'))
for name in ('background.js', 'content.js'):
    s = open(f'{ext}/{name}').read().replace("'i.redd.it'", "'localhost'")
    open(f'{ext}/{name}', 'w').write(s)
m = json.load(open(f'{ext}/manifest.json'))
m['host_permissions'] = ['http://localhost/*']
m['content_scripts'][0]['matches'] = ['http://localhost/*']
json.dump(m, open(f'{ext}/manifest.json', 'w'))

for i in range(1, 5):
    shutil.copy(f'{shots}/{i}.png', f'{site}/shot{i}.png')
for name in ('Sonoma', 'iMac Blue', 'Radial Sky Blue'):
    subprocess.run(['sips', '-s', 'format', 'jpeg', '-Z', '1600', f'/System/Library/Desktop Pictures/{name}.heic',
                    '--out', f'{site}/photo-{name.replace(" ", "")}.jpg'], capture_output=True)
open(f'{site}/index.html', 'w').write('<!doctype html><body style="background:#0e1113;margin:0"><div id=f style="display:flex;flex-wrap:wrap;gap:8px"></div></body>')

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=site)
handler.log_message = lambda *a: None
class Q(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=site, **k)
    def log_message(self, *a): pass
    def do_GET(self):
        if 'slow' in self.path: time.sleep(.5)
        super().do_GET()
srv = http.server.ThreadingHTTPServer(('localhost', 0), Q)
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = f'http://localhost:{srv.server_port}'

# Another origin for video previews, with Range like v.redd.it. /nocors/ leaves out the CORS header.
class Media(Q):
    def do_GET(self):
        path = f'{site}/{self.path.split("?")[0].replace("/nocors/", "/").lstrip("/")}'
        if not os.path.isfile(path): return self.send_error(404)
        data = open(path, 'rb').read()
        start, end, status = 0, len(data) - 1, 200
        r = self.headers.get('Range')
        if r:
            a, b = r.split('=')[1].split('-')
            start, end, status = int(a), int(b) if b else end, 206
        self.send_response(status)
        self.send_header('Content-Type', 'video/webm')
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Length', str(end - start + 1))
        if status == 206: self.send_header('Content-Range', f'bytes {start}-{end}/{len(data)}')
        if not self.path.startswith('/nocors/'): self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(data[start:end + 1])
media_srv = http.server.ThreadingHTTPServer(('localhost', 0), Media)
threading.Thread(target=media_srv.serve_forever, daemon=True).start()
media = f'http://localhost:{media_srv.server_port}'

# Preview-sized clips. VP9 because Playwright's Chromium has no H.264.
def clip(name, parts, size='170:96'):
    inputs = [x for part in parts for x in ('-loop', '1', '-t', '2', '-r', '10', '-i', part)]
    scale = ''.join(f'[{i}]scale={size}:force_original_aspect_ratio=increase,crop={size},setsar=1,format=yuv420p[v{i}];' for i in range(len(parts)))
    joined = ''.join(f'[v{i}]' for i in range(len(parts))) + f'concat=n={len(parts)}:v=1[out]'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', *inputs, '-filter_complex', scale + joined, '-map', '[out]', '-c:v', 'libvpx-vp9', '-b:v', '64k', '-g', '10', f'{site}/{name}'], check=True)
UI = [f'{site}/shot{i}.png' for i in (1, 2, 3, 4)]
UI.append(UI[0])
PHOTO = f'{site}/photo-Sonoma.jpg'
SKY = f'{site}/photo-iMacBlue.jpg'
BLACK = f'{work}/black.png'
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=black:s=320x180', '-frames:v', '1', BLACK], check=True)
clip('vid-ui.webm', UI)
clip('vid-ui2.webm', list(reversed(UI)))
clip('vid-ui-phone.webm', UI, '96:170')
clip('vid-intro.webm', [BLACK, *UI[1:]])
clip('vid-photo.webm', [PHOTO, SKY, PHOTO, SKY, PHOTO])
clip('vid-mixed.webm', [UI[0], PHOTO, UI[1], SKY, UI[2]])
clip('vid-late.webm', UI[:4])
clip('vid-hold.webm', UI[:4])
clip('vid-gif.webm', UI[1:])
clip('vid-nocors.webm', UI[:3])

# Images a screenshot detector must leave alone, plus a dark UI screenshot.
MAKE = """async () => {
  const mk = async (name, w, h, draw, type='image/png') => {
    const c = new OffscreenCanvas(w, h), x = c.getContext('2d'); draw(x, w, h);
    const b = await c.convertToBlob({type, quality: .85});
    await fetch('/noop').catch(()=>{});
    return [name, [...new Uint8Array(await b.arrayBuffer())]];
  };
  const noise = (x, X, Y, w, h, base) => { const d = x.createImageData(w, h); for (let i=0;i<d.data.length;i+=4){ const n=Math.random()*40-20, g=(i/4%w)/w*60; d.data[i]=base[0]+n+g; d.data[i+1]=base[1]+n; d.data[i+2]=base[2]+n-g; d.data[i+3]=255;} x.putImageData(d,X,Y); };
  return Promise.all([
    mk('neg-meme.jpg', 800, 800, (x,w,h)=>{ x.fillStyle='#fff'; x.fillRect(0,0,w,h); x.fillStyle='#000'; x.font='40px sans-serif'; x.fillText('when the review takes 3 weeks',60,90); noise(x,0,160,800,640,[120,100,80]); }, 'image/jpeg'),
    mk('neg-product.jpg', 800, 800, (x,w,h)=>{ x.fillStyle='#fff'; x.fillRect(0,0,w,h); noise(x,180,150,440,500,[170,60,50]); }, 'image/jpeg'),
    mk('neg-paper-photo.jpg', 800, 600, (x,w,h)=>{ noise(x,0,0,w,h,[205,205,200]); }, 'image/jpeg'),
    mk('neg-dark-ui.png', 900, 500, (x,w,h)=>{ x.fillStyle='#121212'; x.fillRect(0,0,w,h); x.fillStyle='#eee'; x.font='24px sans-serif'; for(let i=0;i<8;i++) x.fillText('Installs & uninstalls  489',40,60+i*50); }),
    mk('pos-cream-chart.png', 1100, 750, (x,w,h)=>{ x.fillStyle='#feecdc'; x.fillRect(0,0,w,h); x.fillStyle='#f9dccb'; x.fillRect(880,0,220,h); x.strokeStyle='#887'; for(let i=1;i<4;i++){ x.beginPath(); x.moveTo(0,i*170); x.lineTo(w,i*170); x.stroke(); } const cs=['#0a2a8c','#1a7fd6','#d10f0f','#7fae1e']; for(let i=0;i<25;i++){ let y=680; for(const c of cs){ const b=8+((i*7+c.charCodeAt(2))%30)*(1+i/10); x.fillStyle=c; x.fillRect(30+i*42,y-b,30,b); y-=b; } } }),
    mk('neg-red-heatmap.png', 1100, 600, (x,w,h)=>{ x.fillStyle='#000'; x.fillRect(0,0,w,h); for(let i=0;i<30;i++) for(let j=0;j<16;j++){ x.fillStyle='#7f1820'; x.fillRect(i*37+1,j*37+1,35,35); x.fillStyle='#eee'; x.fillRect(i*37+12,j*37+12,12,12); } }),
    mk('neg-white-sky.jpg', 900, 600, (x,w,h)=>{ x.fillStyle='#fff'; x.fillRect(0,0,w,h); noise(x,0,330,900,270,[90,110,70]); }, 'image/jpeg'),
    ...[['partial-photos.png', true], ['partial-strict.png', false], ['partial-cream.png', false, '#feecdc']].map(([name, photos, page]) => mk(name, 1200, 800, (x,w,h)=>{ x.fillStyle=page||'#fff'; x.fillRect(0,0,w,h); x.fillStyle='#222'; x.font='18px sans-serif'; for(let i=0;i<26;i++) x.fillText('Lorem ipsum dolor sit amet, consectetur adipiscing elit',30,430+i*14+(i%2)); if(photos){ noise(x,30,30,400,330,[150,130,110]); noise(x,460,30,400,330,[120,140,150]); } x.fillStyle='#14202e'; x.fillRect(900,60,270,photos?360:300); x.fillStyle='#eee'; for(let i=0;i<9;i++) x.fillText('Panel row '+i,920,100+i*30); })),
    mk('frame-dark.png', 1200, 800, (x,w,h)=>{ x.fillStyle='#ecece4'; x.fillRect(0,0,w,h); x.fillStyle='#333'; x.font='18px sans-serif'; x.fillText('IMAGE 01',50,30); x.fillStyle='#111'; x.fillRect(50,45,1100,330); x.fillStyle='#333'; x.fillText('IMAGE 02',50,405); x.fillStyle='#111'; x.fillRect(50,420,1100,340); x.fillStyle='#ddd'; x.fillText('Dark panel text',100,120); }),
    mk('neg-caption-bars.png', 1200, 800, (x,w,h)=>{ x.fillStyle='#fff'; x.fillRect(0,0,w,h); x.fillStyle='#111'; x.fillRect(0,110,w,580); x.font='40px sans-serif'; x.fillText('top text',60,70); x.fillText('bottom text',60,760); }),
    mk('partial-lines.png', 1200, 800, (x,w,h)=>{ x.fillStyle='#fff'; x.fillRect(0,0,w,h); x.fillStyle='#222'; x.font='18px sans-serif'; for(let i=0;i<26;i++) x.fillText('Lorem ipsum dolor sit amet, consectetur adipiscing elit',30,430+i*14+(i%2)); noise(x,30,30,400,330,[150,130,110]); noise(x,460,30,400,330,[120,140,150]); x.fillStyle='#14202e'; x.fillRect(900,60,270,360); x.strokeStyle='#888'; x.lineWidth=2; x.strokeRect(10,10,1180,780); for(const y of [20,200,395]){ x.beginPath(); x.moveTo(10,y); x.lineTo(1190,y); x.stroke(); } }),
    mk('pos-text-ui.png', 900, 500, (x,w,h)=>{ x.fillStyle='#fff'; x.fillRect(0,0,w,h); x.fillStyle='#222'; x.font='18px sans-serif'; for(let i=0;i<20;i++) x.fillText('Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor',20,26+i*24); }),
  ]);
}"""

fails = []
def check(label, ok, extra=''):
    print(('PASS ' if ok else 'FAIL ') + label, extra)
    if not ok: fails.append(label)

FILTERED = "el => el.style.filter"

with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(f'{work}/profile', headless=False, color_scheme='dark', viewport={'width': 1300, 'height': 900},
        args=['--headless=new', f'--disable-extensions-except={ext}', f'--load-extension={ext}'])
    page = ctx.new_page()
    page.goto(base + '/index.html')
    for name, bytes_ in page.evaluate(MAKE):
        open(f'{site}/{name}', 'wb').write(bytes(bytes_))
    files = sorted(os.path.basename(f) for f in glob.glob(f'{site}/*') if f.endswith(('.png', '.jpg')))

    # Raw numbers from the real detector.
    sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker')
    print(f'{"image":28} light  flat  color  verdict')
    for f in files:
        r = sw.evaluate("async u => { const s = await analyzeBlob(await (await fetch(u)).blob()); return { ...s, screenshot: isLightScreenshot(s, true) }; }", f'{base}/{f}')
        print(f'{f:28} {r["light"]:.2f}   {r["flat"]:.2f}  {r["colorful"]:.2f}   {r["screenshot"]}')
        check(f'detector {f}', r['screenshot'] == (f.startswith('shot') or f.startswith('pos') or f in ('partial-strict.png', 'partial-cream.png')))

    # Reader
    page.evaluate("""fs => { for (const n of fs) { const i = new Image(); i.src='/'+n; i.alt=n; i.style.width='300px'; i.style.height='200px'; i.style.objectFit='contain'; document.getElementById('f').append(i);} 
       const h=document.createElement('x-host'); document.body.append(h); const s=h.attachShadow({mode:'open'}); const i=new Image(); i.src='/shot3.png'; i.id='shadow'; i.style.width='300px'; s.append(i); }""", files)
    # Some of these also fetch their full size, so how long this takes varies.
    expected = [f for f in files if f.startswith('shot') or f.startswith('pos')]
    for _ in range(80):
        if all(page.locator(f'img[alt="{f}"]').evaluate(FILTERED) for f in expected): break
        page.wait_for_timeout(100)
    page.wait_for_timeout(500)
    for f in files:
        v = page.locator(f'img[alt="{f}"]').evaluate(FILTERED)
        check(f'reader dark theme {f}', bool(v) == (f.startswith('shot') or f.startswith('pos')), v)
    check('image in shadow root', 'invert' in page.evaluate("document.querySelector('x-host').shadowRoot.querySelector('img').style.filter"))
    def px(f, x, y):
        shot = base64.b64encode(page.locator(f'img[alt="{f}"]').screenshot()).decode()
        return page.evaluate("""async ([shot, x, y]) => {
          const bitmap = await createImageBitmap(await (await fetch('data:image/png;base64,' + shot)).blob());
          const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
          ctx.drawImage(bitmap, 0, 0);
          return [...ctx.getImageData(x * bitmap.width, y * bitmap.height, 1, 1).data].slice(0, 3);
        }""", [shot, x, y])
    # Partly dark: the page goes dark, panels and photos keep their colors. The box is
    # 300x200 with object-fit: contain, and these images are 3:2 too, so points line up.
    for f in ('partial-photos.png', 'partial-strict.png', 'partial-lines.png'):
        el = page.locator(f'img[alt="{f}"]')
        check(f'{f}: partly dark, no filter', 'url("data:image/webp' in el.evaluate("el => el.style.content") and not el.evaluate(FILTERED))
        el.scroll_into_view_if_needed()
        check(f'{f}: page darkened', max(px(f, .4, .97)) < 60, px(f, .4, .97))
        check(f'{f}: panel stays dark', px(f, .96, .4)[2] < 80 and px(f, .96, .4)[0] < 60, px(f, .96, .4))
    check('photo stays as it is', 90 < sum(px('partial-photos.png', .2, .25)) / 3 < 200, px('partial-photos.png', .2, .25))
    for f in ('neg-product.jpg', 'neg-meme.jpg', 'neg-white-sky.jpg', 'neg-dark-ui.png'):
        check(f'{f}: not partly dark', not page.locator(f'img[alt="{f}"]').evaluate("el => el.style.content"))
    check('nothing left hidden', page.evaluate("[...document.images].every(i => i.style.visibility !== 'hidden')"))
    page.screenshot(path=f'{work}/reader-dark.png', full_page=True)
    page.emulate_media(color_scheme='light')
    page.wait_for_timeout(200)
    check('light theme removes it live', page.evaluate("[...document.images].every(i => !i.style.filter && !i.style.content)"))
    page.emulate_media(color_scheme='dark')
    page.wait_for_timeout(200)
    check('dark theme brings it back', 'invert' in page.locator('img[alt="shot1.png"]').evaluate(FILTERED))

    # Keeps the site's own filter
    page.evaluate("""() => { const i=new Image(); i.src='/shot2.png?x=1'; i.id='blur'; i.style.cssText='width:300px;filter:blur(4px)'; document.body.append(i); }""")
    page.wait_for_timeout(1000)
    v = page.locator('#blur').evaluate(FILTERED)
    check('keeps blur', 'blur' in v and 'invert' in v, v)

    # Stuck-hidden cases: each must end up visible with a verdict applied
    page.evaluate("""() => { const d=document.createElement('div'); d.id='restored'; d.innerHTML = `<img id=saved src="/shot1.png?saved" style="width:300px;visibility:hidden !important;filter:invert(0.93) hue-rotate(180deg) !important">`; document.body.append(d); }""")
    page.wait_for_timeout(1000)
    check('restored markup: not hidden', page.locator('#saved').evaluate("el => el.style.visibility") == '')
    check('restored markup: dark once', page.locator('#saved').evaluate(FILTERED).count('invert') == 1)
    page.evaluate("""() => { const i=document.getElementById('saved'); i.remove(); return new Promise(r => setTimeout(r, 100)).then(() => document.body.append(i)); }""")
    page.wait_for_timeout(500)
    check('re-attached: not hidden', page.locator('#saved').evaluate("el => el.style.visibility") == '')
    shutil.copy(f'{site}/shot2.png', f'{site}/slow.png')
    page.evaluate("""() => { const b=document.createElement('div'); b.id='box'; b.style.cssText='height:20px'; const i=new Image(); i.id='late'; i.style.cssText='width:300px;height:100%'; b.append(i); document.body.append(b); i.src='/slow.png'; i.addEventListener('load', () => { b.style.height='200px'; }, {once:true}); }""")
    page.locator('#box').evaluate('el => el.scrollIntoView()')
    # Three slow requests: the page's, the check's, and the full size for partial darkening.
    for _ in range(80):
        if 'invert' in page.locator('#late').evaluate(FILTERED): break
        page.wait_for_timeout(100)
    check('sized after load: not hidden', page.locator('#late').evaluate("el => el.style.visibility") == '')
    check('sized after load: darkened', 'invert' in page.locator('#late').evaluate(FILTERED))

    # Right-click override, message sent the way the menu sends it
    page.locator('img[alt="shot1.png"]').click(button='right')
    page.keyboard.press('Escape')
    sw.evaluate("async () => { for (const t of await chrome.tabs.query({})) chrome.tabs.sendMessage(t.id, {type:'toggle-image'}).catch(()=>{}); }")
    page.wait_for_timeout(300)
    check('override turns it off', not page.locator('img[alt="shot1.png"]').evaluate(FILTERED))
    sw.evaluate("async () => { for (const t of await chrome.tabs.query({})) chrome.tabs.sendMessage(t.id, {type:'toggle-image'}).catch(()=>{}); }")
    page.wait_for_timeout(300)
    check('override turns it on', 'invert' in page.locator('img[alt="shot1.png"]').evaluate(FILTERED))

    # Tinted setting: live, without a new fetch, and white screenshots aren't affected
    sw.evaluate("chrome.storage.local.set({settings:{tinted:false}})"); page.wait_for_timeout(300)
    check('tinted off leaves the cream chart', not page.locator('img[alt="pos-cream-chart.png"]').evaluate(FILTERED))
    check('tinted off still darkens white', 'invert' in page.locator('img[alt="shot1.png"]').evaluate(FILTERED))
    sw.evaluate("chrome.storage.local.set({settings:{tinted:true}})"); page.wait_for_timeout(300)
    check('tinted on darkens the cream chart', 'invert' in page.locator('img[alt="pos-cream-chart.png"]').evaluate(FILTERED))

    # A pale frame around a dark image
    frame = page.locator('img[alt="frame-dark.png"]')
    frame.scroll_into_view_if_needed()
    check('frame: partly dark, no filter', 'url("data:image/webp' in frame.evaluate("el => el.style.content") and not frame.evaluate(FILTERED))
    check('frame: frame darkened', max(px('frame-dark.png', .5, .97)) < 60, px('frame-dark.png', .5, .97))
    check('frame: dark panel stays dark', max(px('frame-dark.png', .5, .3)) < 40, px('frame-dark.png', .5, .3))
    caption = page.locator('img[alt="neg-caption-bars.png"]')
    check('caption bars on two sides: left alone', not caption.evaluate("el => el.style.content") and not caption.evaluate(FILTERED))
    sw.evaluate("chrome.storage.local.set({settings:{frames:false}})"); page.wait_for_timeout(300)
    check('frames off leaves the frame', not frame.evaluate("el => el.style.content") and not frame.evaluate(FILTERED))
    sw.evaluate("chrome.storage.local.set({settings:{frames:true}})"); page.wait_for_timeout(300)
    check('frames back on darkens it again', 'url(' in frame.evaluate("el => el.style.content"))

    # Partly dark images and the settings and override
    partial = page.locator('img[alt="partial-cream.png"]')
    content = "el => el.style.content"
    check('cream page with a panel: partly dark', 'url(' in partial.evaluate(content))
    sw.evaluate("chrome.storage.local.set({settings:{tinted:false}})"); page.wait_for_timeout(300)
    check('tinted off leaves the cream page', not partial.evaluate(content) and not partial.evaluate(FILTERED))
    sw.evaluate("chrome.storage.local.set({settings:{tinted:true}})"); page.wait_for_timeout(300)
    partial = page.locator('img[alt="partial-photos.png"]')
    partial.click(button='right'); page.keyboard.press('Escape')
    sw.evaluate("async () => { for (const t of await chrome.tabs.query({})) chrome.tabs.sendMessage(t.id, {type:'toggle-image'}).catch(()=>{}); }"); page.wait_for_timeout(300)
    check('override turns partly dark off', not partial.evaluate(content) and not partial.evaluate(FILTERED))
    sw.evaluate("async () => { for (const t of await chrome.tabs.query({})) chrome.tabs.sendMessage(t.id, {type:'toggle-image'}).catch(()=>{}); }"); page.wait_for_timeout(300)
    check('override turns partly dark back on', 'url(' in partial.evaluate(content) and not partial.evaluate(FILTERED))
    keep_overrides = sw.evaluate("chrome.storage.local.get('overrides').then(o => o.overrides)")
    page.reload(); page.wait_for_timeout(300)
    page.evaluate("""() => { const i = new Image(); i.src='/partial-photos.png'; i.alt='again'; i.style.width='300px'; document.body.prepend(i); }""")
    page.wait_for_timeout(1500)
    check('turned back on survives a reload as partly dark', 'url(' in page.locator('img[alt="again"]').evaluate(content), str(keep_overrides))
    page.evaluate("""fs => { for (const n of fs) { const i = new Image(); i.src='/'+n; i.alt=n; i.style.width='300px'; i.style.height='200px'; i.style.objectFit='contain'; document.getElementById('f').append(i);} }""", files)
    page.wait_for_timeout(1500)
    sw.evaluate("chrome.storage.local.remove('overrides')"); page.wait_for_timeout(200)

    # Right-click on an image in a shadow root, then somewhere with no image
    toggle = "async () => { for (const t of await chrome.tabs.query({})) chrome.tabs.sendMessage(t.id, {type:'toggle-image'}).catch(()=>{}); }"
    page.evaluate("""() => { const h=document.createElement('x-media'); h.style.cssText='display:block;width:300px;height:200px'; const s=h.attachShadow({mode:'open'});
       const i=new Image(); i.src='/shot4.png?card'; i.style.cssText='width:100%;height:100%;object-fit:contain'; s.append(i); document.body.prepend(h); }""")
    page.wait_for_timeout(1000)
    shadowed = "document.querySelector('x-media').shadowRoot.querySelector('img').style.filter"
    check('shadow image starts dark', 'invert' in page.evaluate(shadowed))
    box = page.locator('x-media').bounding_box()
    page.mouse.click(box['x'] + 150, box['y'] + 100, button='right')
    page.keyboard.press('Escape')
    sw.evaluate(toggle); page.wait_for_timeout(300)
    check('override works in a shadow root', not page.evaluate(shadowed))
    sw.evaluate("chrome.storage.local.remove('overrides')"); page.wait_for_timeout(200)
    page.mouse.click(1285, 885, button='right')
    page.keyboard.press('Escape')
    before = page.locator('img[alt="shot2.png"]').evaluate(FILTERED)
    sw.evaluate(toggle); page.wait_for_timeout(200)
    check('toggle off an image does nothing', page.locator('img[alt="shot2.png"]').evaluate(FILTERED) == before)

    # Uploader: a Reddit-style input in an open shadow root, with listeners that record what the page receives.
    upload = ctx.new_page()
    upload.goto(base + '/index.html')
    upload.evaluate("""() => {
      window.got = [];
      const read = async (src, file) => { const b = await createImageBitmap(file); const c = new OffscreenCanvas(1,1).getContext('2d'); c.drawImage(b,0,0,1,1,0,0,1,1); const d=c.getImageData(0,0,1,1).data; window.got.push({src, name:file.name, type:file.type, corner:[...d].slice(0,3)}); };
      const h = document.createElement('rte-toolbar-button-image'); document.body.append(h);
      const s = h.attachShadow({mode:'open'}); const i = document.createElement('input'); i.type='file'; i.id='up'; s.append(i);
      i.addEventListener('change', () => { for (const f of i.files) read('input', f); });
      const box = document.createElement('div'); box.id='box'; box.contentEditable='true'; box.style.cssText='width:400px;height:200px;background:#333'; document.body.append(box);
      box.addEventListener('paste', e => { e.preventDefault(); for (const f of e.clipboardData.files) read('paste', f); });
      box.addEventListener('dragover', e => e.preventDefault());
      box.addEventListener('drop', e => { e.preventDefault(); for (const f of e.dataTransfer.files) read('drop', f); });
    }""")
    cdp = ctx.new_cdp_session(upload)
    cdp.send('DOM.enable'); cdp.send('Runtime.enable')
    def set_files(path):
        obj = cdp.send('Runtime.evaluate', {'expression': "document.querySelector('rte-toolbar-button-image').shadowRoot.querySelector('input')"})
        cdp.send('DOM.setFileInputFiles', {'files': [path], 'objectId': obj['result']['objectId']})
    def got(): return upload.evaluate("window.got.splice(0)")

    set_files(f'{site}/shot4.png'); upload.wait_for_timeout(1500)
    r = got(); print(r); check('upload input: screenshot darkened once', len(r) == 1 and r[0]['name'] == 'shot4.png' and max(r[0]['corner']) < 100)
    set_files(f'{site}/photo-Sonoma.jpg'); upload.wait_for_timeout(1500)
    r = got(); print(r); check('upload input: photo passed through', len(r) == 1 and r[0]['name'].startswith('photo'))

    # Drop
    box = upload.locator('#box').bounding_box(); x, y = box['x'] + 50, box['y'] + 50
    data = {'items': [], 'files': [f'{site}/shot3.png'], 'dragOperationsMask': 1}
    for t in ('dragEnter', 'dragOver', 'drop'):
        cdp.send('Input.dispatchDragEvent', {'type': t, 'x': x, 'y': y, 'data': data})
    upload.wait_for_timeout(1500)
    r = got(); print(r); check('drop: screenshot darkened', len(r) == 1 and max(r[0]['corner']) < 100)

    # Paste of an image-only clipboard
    ctx.grant_permissions(['clipboard-read', 'clipboard-write'], origin=base)
    upload.bring_to_front()
    upload.locator('#box').click()
    upload.evaluate("async () => { const b = await (await fetch('/shot4.png')).blob(); const p = await createImageBitmap(b); const c = new OffscreenCanvas(p.width,p.height); c.getContext('2d').drawImage(p,0,0); await navigator.clipboard.write([new ClipboardItem({'image/png': await c.convertToBlob()})]); }")
    upload.keyboard.press('Meta+V'); upload.wait_for_timeout(1500)
    r = got(); print(r); check('paste: screenshot darkened', len(r) == 1 and max(r[0]['corner']) < 100)

    # Settings: uploader off passes the original through
    sw.evaluate("chrome.storage.local.set({settings:{uploader:false}})")
    upload.wait_for_timeout(200)
    set_files(f'{site}/shot4.png'); upload.wait_for_timeout(800)
    r = got(); print(r); check('uploader off: left alone', len(r) >= 1 and min(r[0]['corner']) > 200)
    sw.evaluate("chrome.storage.local.set({settings:{uploader:true, reader:false}})")
    page.bring_to_front(); page.wait_for_timeout(300)
    check('reader off removes it', not page.locator('img[alt="shot2.png"]').evaluate(FILTERED))
    sw.evaluate("chrome.storage.local.set({settings:{reader:true, readerMode:'always'}})")
    page.emulate_media(color_scheme='light'); page.wait_for_timeout(300)
    check('always mode ignores light theme', 'invert' in page.locator('img[alt="shot2.png"]').evaluate(FILTERED))

    # Screen recordings. A player like Reddit's: the video in an open shadow root, the preview in an attribute.
    vid = ctx.new_page()
    vid.goto(base + '/index.html')
    ADD = """([id, attrs, late]) => {
      const p = document.createElement('shreddit-player'); p.id = id; p.style.cssText = 'display:block;width:300px;height:170px';
      for (const [k, v] of Object.entries(attrs)) p.setAttribute(k, v);
      document.getElementById('f').append(p);
      const fill = () => { const s = p.attachShadow({mode:'open'}); const v = document.createElement('video'); v.style.cssText='width:100%;height:100%;object-fit:contain;background:#000';
        const ui = document.createElement('shreddit-media-ui'), bar = document.createElement('shreddit-progress-bar'), lazy = document.createElement('shreddit-preview-video-lazy');
        const h = document.createElement('video'); h.className = 'scrub'; h.src = attrs.preview || ''; h.style.cssText = 'width:100px;height:60px;background:#000';
        s.append(v, ui); ui.attachShadow({mode:'open'}).append(bar); bar.attachShadow({mode:'open'}).append(lazy);
        setTimeout(() => lazy.attachShadow({mode:'open'}).append(h), 800); };
      late ? setTimeout(fill, 1200) : fill();
    }"""
    def add(id, attrs, late=False): vid.evaluate(ADD, [id, attrs, late])
    def vfilter(id): return vid.evaluate("id => { const v = document.getElementById(id).shadowRoot?.querySelector('video'); return v ? v.style.filter : null }", id)
    def vhidden(id): return vid.evaluate("id => document.getElementById(id).shadowRoot.querySelector('video').style.visibility", id)

    # Off: the setting defaults to off
    sw.evaluate("chrome.storage.local.set({settings:{reader:true, readerMode:'always', videos:false, uploader:true}})")
    vid.wait_for_timeout(200)
    add('off', {'preview': f'{media}/vid-ui.webm'})
    vid.wait_for_timeout(1500)
    check('video setting off: left alone', not vfilter('off') and vhidden('off') == '')

    sw.evaluate("chrome.storage.local.set({settings:{reader:true, readerMode:'always', videos:true, uploader:true}})")
    vid.wait_for_timeout(200)
    check('video setting on: applies live', 'invert' in (vfilter('off') or '') or vid.wait_for_timeout(3000) or 'invert' in (vfilter('off') or ''))

    add('ui', {'preview': f'{media}/vid-ui2.webm'})
    add('phone', {'preview': f'{media}/vid-ui-phone.webm'})
    add('intro', {'preview': f'{media}/vid-intro.webm'})
    add('photo', {'preview': f'{media}/vid-photo.webm'})
    add('mixed', {'preview': f'{media}/vid-mixed.webm'})
    add('gif', {'gif': '', 'src': f'{media}/vid-gif.webm'})
    add('late', {'preview': f'{media}/vid-late.webm'}, True)
    add('nocors', {'preview': f'{media}/nocors/vid-nocors.webm'})
    add('dead', {'preview': f'{media}/missing.webm'})
    add('nopreview', {})
    vid.wait_for_timeout(600)
    check('video hidden while checking', vhidden('ui') == 'hidden' or 'invert' in vfilter('ui'), vhidden('ui'))
    check('player hidden before its video exists', vid.evaluate("getComputedStyle(document.getElementById('late')).visibility") == 'hidden')
    vid.wait_for_timeout(9000)
    for id in ('ui', 'phone', 'intro', 'gif', 'late'):
        check(f'video {id}: darkened', 'invert' in (vfilter(id) or ''), vfilter(id))
    for id in ('photo', 'mixed', 'nocors', 'dead', 'nopreview'):
        check(f'video {id}: left alone', not vfilter(id), vfilter(id))
    check('no video stuck hidden', vid.evaluate("[...document.querySelectorAll('shreddit-player')].every(p => [...p.shadowRoot.querySelectorAll('video')].every(v => v.style.visibility !== 'hidden'))"))
    vid.wait_for_timeout(1000)
    def scrub(id, prop): return vid.evaluate("([id, prop]) => document.getElementById(id).shadowRoot.querySelector('shreddit-media-ui').shadowRoot.querySelector('shreddit-progress-bar').shadowRoot.querySelector('shreddit-preview-video-lazy').shadowRoot.querySelector('video').style[prop]", [id, prop])
    for id in ('ui', 'phone', 'intro', 'photo', 'mixed', 'nocors', 'dead', 'nopreview'):
        check(f'scrubber thumbnail {id}: follows its player', ('invert' in scrub(id, 'filter')) == ('invert' in (vfilter(id) or '')), scrub(id, 'filter'))
        check(f'scrubber thumbnail {id}: not stuck hidden', scrub(id, 'visibility') != 'hidden')
    check('scrubber thumbnail: bars stay dark', scrub('ui', 'backgroundColor') == 'rgb(255, 255, 255)', scrub('ui', 'backgroundColor'))
    vid.screenshot(path=f'{work}/videos.png', full_page=True)
    # The bars beside a tall video stay dark, darkened or not.
    def bar(id):
        shot = base64.b64encode(vid.locator(f'#{id} video').first.screenshot()).decode()
        return vid.evaluate("""async (shot) => {
          const bitmap = await createImageBitmap(await (await fetch('data:image/png;base64,' + shot)).blob());
          const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
          ctx.drawImage(bitmap, 0, 0);
          return ctx.getImageData(5, 85, 1, 1).data[0];
        }""", shot)
    check('tall video: bars stay dark', bar('phone') <= 40, bar('phone'))
    check('photo video: bars untouched', bar('photo') <= 40, bar('photo'))

    # A reload knows the verdict: the video never shows unfiltered, however late the player draws it.
    check('verdict saved for the reload', any(k.endswith('/vid-late.webm') and v for k, v in sw.evaluate("chrome.storage.local.get('videoChecks')")['videoChecks'].items()))
    again = ctx.new_page(); again.goto(base + '/index.html'); again.wait_for_timeout(200)
    again.evaluate(ADD, ['re', {'preview': f'{media}/vid-late.webm'}, True])
    again.evaluate("""() => { window.flashes = 0; const p = document.getElementById('re');
      const look = () => { const v = p.shadowRoot?.querySelector('video');
        if (getComputedStyle(p).visibility !== 'hidden' && (!v || !v.style.filter.includes('invert'))) window.flashes++;
        requestAnimationFrame(look); }; look(); }""")
    again.wait_for_timeout(2000)
    check('reload: never shown undarkened', again.evaluate('window.flashes') == 0, again.evaluate('window.flashes'))
    check('reload: shown dark once drawn', again.evaluate("getComputedStyle(document.getElementById('re')).visibility") == 'visible' and 'invert' in again.evaluate("document.getElementById('re').shadowRoot.querySelector('video').style.filter"))
    again.evaluate(ADD, ['gone', {'preview': f'{media}/vid-photo.webm'}, False]); again.wait_for_timeout(300)
    check('reload: a video left alone shows right away', again.evaluate("getComputedStyle(document.getElementById('gone')).visibility") == 'visible' and not again.evaluate("document.getElementById('gone').shadowRoot.querySelector('video').style.filter"))
    again.close()

    # While the check runs, the player shows the animated icon instead of an empty box.
    stalled = []
    ctx.route('**/vid-hold.webm', lambda route: stalled.append(route))
    hold = ctx.new_page(); hold.goto(base + '/index.html'); hold.wait_for_timeout(200)
    hold.evaluate(ADD, ['h', {'preview': f'{media}/vid-hold.webm'}, False])
    hold.wait_for_timeout(800)
    def before(page, prop): return page.evaluate("prop => getComputedStyle(document.getElementById('h'), '::before')[prop]", prop)
    check('loading icon: shown while checking', before(hold, 'content') != 'none' and before(hold, 'visibility') == 'visible' and before(hold, 'opacity') == '1', before(hold, 'content'))
    check('loading icon: sweeps and pulses', all(name in before(hold, 'animationName') for name in ('sweep', 'pulse')), before(hold, 'animationName'))
    check('loading icon: video stays hidden', hold.evaluate("getComputedStyle(document.getElementById('h').shadowRoot.querySelector('video')).visibility") == 'hidden')
    for i in range(3):
        hold.screenshot(path=f'{work}/applying{i}.png', clip={'x': 0, 'y': 0, 'width': 300, 'height': 170})
        hold.wait_for_timeout(500)
    for route in stalled: route.continue_()
    ctx.unroute('**/vid-hold.webm')
    hold.wait_for_timeout(2500)
    check('loading icon: gone once dark', before(hold, 'content') == 'none' and 'invert' in hold.evaluate("document.getElementById('h').shadowRoot.querySelector('video').style.filter"), before(hold, 'content'))
    hold.close()

    # Right-click override on a video
    vid.bring_to_front()
    def toggle():
        vid.locator('#ui video').first.click(button='right')
        vid.keyboard.press('Escape')
        sw.evaluate("async () => { for (const t of await chrome.tabs.query({})) chrome.tabs.sendMessage(t.id, {type:'toggle-image'}).catch(()=>{}); }")
        vid.wait_for_timeout(300)
    toggle()
    check('video override turns it off', not vfilter('ui'))
    check('video override reaches the scrubber thumbnail', not scrub('ui', 'filter'))
    check('video override restores the background', vid.evaluate("document.getElementById('ui').shadowRoot.querySelector('video').style.backgroundColor") == 'rgb(0, 0, 0)')
    toggle()
    check('video override turns it on', 'invert' in vfilter('ui'))

    sw.evaluate("chrome.storage.local.set({settings:{reader:true, readerMode:'always', videos:false, uploader:true}, overrides:{}})")
    vid.wait_for_timeout(300)
    check('turning the setting off removes it', not vfilter('phone'))

    # Popup
    extid = sw.url.split('/')[2]
    pop = ctx.new_page(); pop.set_viewport_size({'width': 300, 'height': 440}); pop.emulate_media(color_scheme='dark')
    pop.goto(f'chrome-extension://{extid}/popup/popup.html'); pop.wait_for_timeout(300)
    pop.screenshot(path=f'{work}/popup.png')
    check('popup: checkbox starts unticked', not pop.locator('#videos').is_checked())
    pop.locator('#videos').click(); pop.wait_for_timeout(100)
    check('popup: checkbox saves', sw.evaluate("chrome.storage.local.get('settings')")['settings']['videos'] is True)
    pop.screenshot(path=f'{work}/popup-on.png')
    check('popup: frames starts ticked', pop.locator('#frames').is_checked())
    pop.locator('#frames').click(); pop.wait_for_timeout(100)
    check('popup: frames saves', sw.evaluate("chrome.storage.local.get('settings')")['settings']['frames'] is False)

    ctx.close()
print('\nFAILED:', fails if fails else 'none')
