# Loads a copy of the extension pointed at localhost and plays recordings with light UI
# over footage in a player like Reddit's.
# usage: python3 test/parts.py <work dir> [a real clip, for a look at it]
import base64, http.server, json, os, shutil, subprocess, sys, threading
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
work = sys.argv[1]
real = sys.argv[2] if len(sys.argv) > 2 else None
ext, site = f'{work}/ext', f'{work}/site'
shutil.rmtree(work, ignore_errors=True)
os.makedirs(site)
shutil.copytree(ROOT, ext, ignore=shutil.ignore_patterns('test', '.git'))
m = json.load(open(f'{ext}/manifest.json'))
m['content_scripts'][0]['matches'] = ['http://localhost/*']
json.dump(m, open(f'{ext}/manifest.json', 'w'))
open(f'{site}/index.html', 'w').write('<!doctype html><body style="background:#0e1113;margin:0"><div id=f style="display:flex;flex-wrap:wrap;gap:8px"></div></body>')

class Q(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=site, **k)
    def log_message(self, *a): pass
    def do_GET(self):
        path = f'{site}/{self.path.split("?")[0].lstrip("/")}'
        if not path.endswith('.webm') or not os.path.isfile(path): return super().do_GET()
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
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(data[start:end + 1])
srv = http.server.ThreadingHTTPServer(('localhost', 0), Q)
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = f'http://localhost:{srv.server_port}'

# Footage is a moving picture full of color. The UI, drawn as a page, goes over it: a pale
# toolbar across the top and a popup that moves halfway through.
SCENE = """<!doctype html><body style="margin:0;width:480px;height:270px;overflow:hidden;position:relative;font:7px sans-serif;background:#333">
<canvas id=c width=480 height=270 style="position:absolute;inset:0"></canvas>
<div id=ui style="display:none">
<div style="position:absolute;left:0;top:0;width:480px;height:28px;background:#e8edf5;color:#222;padding:9px 12px;box-sizing:border-box">youtube.com/watch ▪ ▪ ▪ reader mode tabs back forward reload extensions</div>
<div id=pop style="position:absolute;top:28px;width:150px;height:190px;background:#f8f8fb;color:#222;padding:8px;box-sizing:border-box"></div>
</div></body>"""
DRAW = """([t, ui]) => {
  const x = document.getElementById('c').getContext('2d');
  for (let i = 0; i < 48; i++) for (let j = 0; j < 27; j++) {
    const v = Math.sin(i / 3 + t * 2) + Math.cos(j / 2 - t), n = (i * 7 + j * 13 + Math.floor(t * 9)) % 17;
    x.fillStyle = `rgb(${130 + 70 * v + n * 2},${70 + n * 4},${90 - 40 * v + n})`;
    x.fillRect(i * 10, j * 10, 10, 10);
  }
  document.getElementById('ui').style.display = ui ? 'block' : 'none';
  const pop = document.getElementById('pop');
  pop.style.left = (t < 2.5 ? 300 : 40) + 'px';
  pop.innerHTML = 'Voice-over settings<br><br>' + 'Translate into Spanish<br>Show subtitles<br><br>'.repeat(6);
}"""

fails = []
def check(label, ok, extra=''):
    print(('ok  ' if ok else 'FAIL'), label, extra)
    if not ok: fails.append(label)

def encode(name, frames_dir, size):
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-framerate', '10', '-i', f'{frames_dir}/%03d.png', '-vf', f'scale={size},format=yuv420p',
                    '-c:v', 'libvpx-vp9', '-b:v', '1M' if size == '480:270' else '100k', '-g', '10', f'{site}/{name}'], check=True)

with sync_playwright() as p:
    b = p.chromium.launch()
    painter = b.new_page(viewport={'width': 480, 'height': 270})
    painter.set_content(SCENE)
    for name, ui in (('rec', True), ('plain', False)):
        d = f'{work}/{name}'; os.makedirs(d)
        for i in range(50):
            painter.evaluate(DRAW, [i / 10, ui])
            painter.screenshot(path=f'{d}/{i + 1:03d}.png')
        encode(f'{name}.webm', d, '480:270')
        encode(f'{name}-96.webm', d, '170:96')
    b.close()
    if real:
        for name, size in (('real', '480:270'), ('real-96', '170:96')):
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', real, '-an', '-vf', f'scale={size},format=yuv420p', '-c:v', 'libvpx-vp9', '-b:v', '800k' if size == '480:270' else '80k', '-g', '30', '-deadline', 'realtime', '-cpu-used', '6', f'{site}/{name}.webm'], check=True)
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', real, '-an', '-vf', 'format=yuv420p', '-c:v', 'libvpx-vp9', '-b:v', '3M', '-g', '30', '-deadline', 'realtime', '-cpu-used', '6', f'{site}/real-full.webm'], check=True)

    ctx = p.chromium.launch_persistent_context(f'{work}/profile', headless=False, color_scheme='dark', viewport={'width': 1300, 'height': 900},
        args=['--headless=new', '--autoplay-policy=no-user-gesture-required', f'--disable-extensions-except={ext}', f'--load-extension={ext}'])
    sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker')
    sw.evaluate("chrome.storage.local.set({settings:{reader:true, readerMode:'always', videos:true, uploader:true}})")
    page = ctx.new_page()
    page.goto(base + '/index.html')
    page.wait_for_timeout(300)
    ADD = """([id, main, preview, larger, w, h]) => {
      const pl = document.createElement('shreddit-player'); pl.id = id; pl.style.cssText = `display:block;position:relative;width:${w}px;height:${h}px;overflow:hidden`;
      pl.setAttribute('preview', preview);
      if (larger) pl.setAttribute('packaged-media-json', JSON.stringify({ playbackMp4s: { permutations: [
        { source: { url: larger + '?low', bitrateBps: 1000, dimensions: { width: 100, height: 56 } } },
        { source: { url: larger, bitrateBps: 2000, dimensions: { width: 480, height: 270 } } },
        { source: { url: larger + '?high', bitrateBps: 9000, dimensions: { width: 1920, height: 1080 } } },
      ] } }));
      document.getElementById('f').append(pl);
      const s = pl.attachShadow({ mode: 'open' });
      const v = document.createElement('video'); v.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000';
      v.muted = true; v.loop = true; v.src = main; v.play();
      const ui = document.createElement('shreddit-media-ui'); ui.style.cssText = 'position:absolute;inset:0;pointer-events:none';
      s.append(v, ui);
    }"""
    def add(id, main, preview, larger, w=640, h=360): page.evaluate(ADD, [id, f'{base}/{main}', f'{base}/{preview}', larger and f'{base}/{larger}', w, h])
    def cover(id): return page.evaluate("id => { const c = document.getElementById(id).shadowRoot.querySelector('[data-dark-parts]'); return c && { path: c.style.clipPath, display: c.style.display, next: c.previousElementSibling.localName, under: c.nextElementSibling.localName } }", id)
    def vfilter(id): return page.evaluate("id => document.getElementById(id).shadowRoot.querySelector('video').style.filter", id)
    def saved(): return sw.evaluate("chrome.storage.local.get('videoChecks')").get('videoChecks', {})
    def shot(id):
        return base64.b64encode(page.locator(f'#{id}').screenshot()).decode()
    def pixel(id, points):
        return page.evaluate("""async ([png, points]) => {
          const bitmap = await createImageBitmap(await (await fetch('data:image/png;base64,' + png)).blob());
          const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
          ctx.drawImage(bitmap, 0, 0);
          return points.map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3));
        }""", [shot(id), points])
    def luma(c): return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
    def seek(id, t):
        page.evaluate("([id, t]) => { const v = document.getElementById(id).shadowRoot.querySelector('video'); v.pause(); v.currentTime = t; }", [id, t])
        page.wait_for_timeout(700)

    add('rec', 'rec.webm', 'rec-96.webm', 'rec.webm')
    add('plain', 'plain.webm', 'plain-96.webm', 'plain.webm')
    page.wait_for_timeout(9000)
    verdicts = saved()
    check('recording: checked as parts', any(k.endswith('/rec-96.webm') and v == 'parts' for k, v in verdicts.items()), verdicts)
    check('footage: checked as neither', any(k.endswith('/plain-96.webm') and v is False for k, v in verdicts.items()), verdicts)
    check('recording: video has no filter', not vfilter('rec'), vfilter('rec'))
    c = cover('rec')
    check('recording: cover right after the video, under the controls', c and c['next'] == 'video' and c['under'] == 'shreddit-media-ui', c)
    check('recording: not left hidden', page.evaluate("getComputedStyle(document.getElementById('rec')).visibility") == 'visible')
    check('footage: no cover, no filter', not cover('plain') and not vfilter('plain'))
    check('footage: not left hidden', page.evaluate("getComputedStyle(document.getElementById('plain')).visibility") == 'visible')

    # Popup on the right at the start, on the left later.
    scale = 640 / 480
    at = lambda x, y: [round(x * scale), round(y * scale)]
    TOOLBAR, POP_R, POP_L, FOOT = at(240, 4), at(375, 120), at(115, 120), at(200, 240)
    seek('rec', 1)
    a = pixel('rec', [TOOLBAR, POP_R, POP_L, FOOT])
    page.locator('#rec').screenshot(path=f'{work}/rec-1s.png')
    check('toolbar goes dark', luma(a[0]) < 60, a[0])
    check('popup goes dark', luma(a[1]) < 60, a[1])
    check('footage stays bright', luma(a[2]) > 70, a[2])
    seek('plain', 1)
    want = pixel('plain', [FOOT])[0]
    check('footage under no cover matches the footage-only video', all(abs(a[3][i] - want[i]) < 40 for i in range(3)), [a[3], want])
    seek('rec', 4)
    a = pixel('rec', [TOOLBAR, POP_R, POP_L])
    page.locator('#rec').screenshot(path=f'{work}/rec-4s.png')
    check('seeking: popup followed to the left', luma(a[2]) < 60, a[2])
    check('seeking: old spot is footage again', luma(a[1]) > 70, a[1])

    # The real file plays along with the real video while it plays.
    page.evaluate("document.getElementById('rec').shadowRoot.querySelector('video').play()")
    page.wait_for_timeout(1500)
    check('playing: cover keeps a shape', bool(cover('rec')['path']), cover('rec'))

    # Right-click override
    def toggle():
        page.locator('#rec video').first.click(button='right', force=True)
        page.keyboard.press('Escape')
        sw.evaluate("async () => { for (const t of await chrome.tabs.query({})) chrome.tabs.sendMessage(t.id, {type:'toggle-image'}).catch(()=>{}); }")
        page.wait_for_timeout(400)
    toggle()
    check('override: cover removed', not cover('rec'))
    check('override: no whole-video filter', not vfilter('rec'))
    toggle()
    check('override: parts come back, not the whole video', cover('rec') and not vfilter('rec'), cover('rec'))
    sw.evaluate("chrome.storage.local.set({settings:{reader:true, readerMode:'always', videos:false, uploader:true}, overrides:{}})")
    page.wait_for_timeout(300)
    check('setting off: cover removed', not cover('rec'))
    sw.evaluate("chrome.storage.local.set({settings:{reader:true, readerMode:'always', videos:true, uploader:true}})")
    page.wait_for_timeout(1000)

    # A link that doesn't load leaves the video as it is.
    add('dead', 'rec.webm', 'rec-96.webm', 'missing.webm')
    page.wait_for_timeout(1500)
    check('dead link: not left hidden', page.evaluate("getComputedStyle(document.getElementById('dead')).visibility") == 'visible')
    check('dead link: no cover, no filter', not cover('dead') and not vfilter('dead'), cover('dead'))

    # Reload knows the verdict.
    page.reload(); page.wait_for_timeout(300)
    add('rec', 'rec.webm', 'rec-96.webm', 'rec.webm')
    page.wait_for_timeout(1200)
    check('reload: cover right away', bool(cover('rec')))

    if real:
        page.evaluate("document.getElementById('f').innerHTML = ''")
        add('real', 'real-full.webm', 'real-96.webm', 'real.webm', 1100, 619)
        page.wait_for_timeout(10000)
        print('real clip verdict', {k: v for k, v in saved().items() if 'real' in k})
        for t in (3, 11, 21, 24, 29, 35, 38):
            seek('real', t)
            page.locator('#real').screenshot(path=f'{work}/real-{t}s.png')
        # Playing, a look at timing: how far the copy is behind and how long a look takes.
        page.evaluate("document.getElementById('real').shadowRoot.querySelector('video').currentTime = 8; document.getElementById('real').shadowRoot.querySelector('video').play()")
        for i in range(8):
            page.wait_for_timeout(500)
            page.locator('#real').screenshot(path=f'{work}/real-play{i}.png')
    ctx.close()
print('\nFAILED:', fails if fails else 'none')
sys.exit(1 if fails else 0)
