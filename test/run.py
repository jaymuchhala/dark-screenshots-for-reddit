# Loads a copy of the extension pointed at localhost and runs it on a mock page.
# usage: python3 test/run.py <screenshots dir> <work dir>
import http.server, json, os, shutil, subprocess, sys, threading, functools, glob, time
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
        check(f'detector {f}', r['screenshot'] == (f.startswith('shot') or f.startswith('pos')))

    # Reader
    page.evaluate("""fs => { for (const n of fs) { const i = new Image(); i.src='/'+n; i.alt=n; i.style.width='300px'; i.style.height='200px'; i.style.objectFit='contain'; document.getElementById('f').append(i);} 
       const h=document.createElement('x-host'); document.body.append(h); const s=h.attachShadow({mode:'open'}); const i=new Image(); i.src='/shot3.png'; i.id='shadow'; i.style.width='300px'; s.append(i); }""", files)
    page.wait_for_timeout(2500)
    for f in files:
        v = page.locator(f'img[alt="{f}"]').evaluate(FILTERED)
        check(f'reader dark theme {f}', bool(v) == (f.startswith('shot') or f.startswith('pos')), v)
    check('image in shadow root', 'invert' in page.evaluate("document.querySelector('x-host').shadowRoot.querySelector('img').style.filter"))
    check('nothing left hidden', page.evaluate("[...document.images].every(i => i.style.visibility !== 'hidden')"))
    page.screenshot(path=f'{work}/reader-dark.png', full_page=True)
    page.emulate_media(color_scheme='light')
    page.wait_for_timeout(200)
    check('light theme removes it live', page.evaluate("[...document.images].every(i => !i.style.filter)"))
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
    page.wait_for_timeout(1500)
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

    # Popup
    extid = sw.url.split('/')[2]
    pop = ctx.new_page(); pop.set_viewport_size({'width': 300, 'height': 370}); pop.emulate_media(color_scheme='dark')
    pop.goto(f'chrome-extension://{extid}/popup/popup.html'); pop.wait_for_timeout(300)
    pop.screenshot(path=f'{work}/popup.png')

    ctx.close()
print('\nFAILED:', fails if fails else 'none')
