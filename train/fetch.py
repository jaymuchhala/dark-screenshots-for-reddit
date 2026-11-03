# Downloads labelled thumbnails from Wikimedia Commons, for training the screen classifier.
# usage: fetch.py <data dir>
# Writes <data dir>/<class>/<hash>.jpg|png and <data dir>/sources.json. Already fetched files are skipped.
# One request at a time with a gap, and it waits as long as a 429 asks, so a full run takes about an hour.
import hashlib, json, os, re, sys, time, urllib.error, urllib.parse, urllib.request

API = 'https://commons.wikimedia.org/w/api.php'
UA = 'DarkScreenshotsForReddit-training/0.1 (research script)'
THUMB = 500
GAP = 0.7
SKIP = re.compile(r'game|film|movie|television|\btv\b|video|anime|cartoon|logo|icon|screenshots? of (?:youtube|vimeo)|photograph|map', re.I)

# class -> (categories, how many files, how deep to follow subcategories)
CLASSES = {
    'face': (['Portrait photographs of men', 'Portrait photographs of women', 'Webcam images', 'Selfies'], 60, 1),
    'screen': (['Screenshots of software', 'Screenshots of web browsers', 'Screenshots of websites', 'Website screenshots', 'Screenshots of web pages',
                'Screenshots of Microsoft Windows', 'Screenshots of macOS', 'Screenshots of Linux', 'Screenshots of Android (operating system)',
                'Screenshots of iOS', 'Screenshots of Wikipedia', 'Screenshots of email clients', 'Screenshots of social media',
                'Screenshots of Microsoft Office', 'Screenshots of GNOME', 'Screenshots of KDE', 'Free software screenshots'], 350, 1),
    'comic': (['Comics', 'Webcomics', 'Comic strips', 'Comic books', 'Political cartoons', 'Editorial cartoons'], 220, 2),
    'meme': (['Internet memes', 'Image macros', 'Memes', 'Demotivational posters'], 200, 2),
    'drawing': (['Line drawings', 'Sketches', 'Pencil drawings', 'Ink drawings', 'Black and white illustrations', 'Coloring book pages'], 220, 1),
    'paper': (['Posters', 'Scanned documents', 'Handwritten documents', 'Newspaper pages', 'Book pages', 'Flyers', 'Infographics', 'Whiteboards', 'Business cards', 'Receipts'], 250, 1),
    'chart': (['Bar charts', 'Line charts', 'Pie charts', 'Scatter plots', 'Line graphs', 'Bar graphs', 'Statistical charts', 'Flowcharts', 'Diagrams'], 250, 1),
    'photo': (['Quality images', 'Featured pictures on Wikimedia Commons', 'Portrait photographs', 'Photographs of food', 'Interiors', 'Office buildings',
               'People using computers', 'Photographs of laptops', 'Laptops', 'Desktop computers', 'Computer monitors', 'Smartphones', 'Objects on white background', 'White backgrounds'], 300, 1),
}

def fetch(url):
    """Body of a URL, or None. Waits as long as a 429 asks; other failures give up after a few tries."""
    for attempt in range(6):
        time.sleep(GAP)
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=30) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code != 429 and e.code < 500: return None
            wait = e.headers.get('Retry-After') or ''
            time.sleep(int(wait) if wait.isdigit() else 30 * (attempt + 1))
        except Exception:
            time.sleep(5)
    return None

def api(**params):
    body = fetch(API + '?' + urllib.parse.urlencode({'format': 'json', 'action': 'query', **params}))
    return json.loads(body) if body else {}

def members(category, kind, limit=500):
    token, got = {}, 0
    while got < limit:
        data = api(list='categorymembers', cmtitle=f'Category:{category}', cmtype=kind, cmlimit=min(500, limit - got), **token)
        items = data.get('query', {}).get('categorymembers', [])
        yield from items
        got += len(items)
        token = data.get('continue', {})
        token.pop('continue', None)
        if not token: return

def walk(roots, want, depth):
    seen, files, level = set(roots), {}, list(roots)
    for d in range(depth + 1):
        # Share the quota around, so one huge category can't fill a class.
        each = max(40, want // max(1, len(level)))
        following = []
        for cat in level:
            for m in members(cat, 'file', each):
                if re.search(r'\.(jpe?g|png|webp|svg)$', m['title'], re.I): files.setdefault(m['title'], cat)
            if d < depth:
                for m in members(cat, 'subcat', 100):
                    name = m['title'].split(':', 1)[1]
                    if name not in seen and not SKIP.search(name):
                        seen.add(name)
                        following.append(name)
        print(f'  depth {d}: {len(level)} categories, {len(files)} files', flush=True)
        level = following
        if not level or len(files) >= want: break
    return files

def thumbs(titles):
    out = {}
    for i in range(0, len(titles), 40):
        data = api(titles='|'.join(titles[i:i + 40]), prop='imageinfo', iiprop='url|mime', iiurlwidth=THUMB)
        for page in data.get('query', {}).get('pages', {}).values():
            info = (page.get('imageinfo') or [{}])[0]
            if info.get('thumburl'): out[page['title']] = info['thumburl']
    return out

def download(job):
    url, path = job
    if os.path.exists(path): return True
    body = fetch(url)
    if not body or len(body) > 20_000_000: return False
    with open(path + '.part', 'wb') as f: f.write(body)
    os.replace(path + '.part', path)
    return True

def main(root):
    sources = {}
    for name, (cats, want, depth) in CLASSES.items():
        print(name, flush=True)
        os.makedirs(f'{root}/{name}', exist_ok=True)
        files = walk(cats, want, depth)
        titles = sorted(files, key=lambda t: hashlib.sha1(t.encode()).hexdigest())[:want]
        urls = thumbs(titles)
        jobs = []
        for title, url in urls.items():
            digest = hashlib.sha1(title.encode()).hexdigest()[:16]
            ext = 'jpg' if re.search(r'\.jpe?g(\?|$)', url, re.I) else 'png'
            jobs.append((url, f'{root}/{name}/{digest}.{ext}'))
            sources[digest] = {'class': name, 'title': title, 'category': files[title]}
        done = sum(map(download, jobs))
        print(f'  {done}/{len(jobs)} downloaded', flush=True)
        json.dump(sources, open(f'{root}/sources.json', 'w'))

if __name__ == '__main__':
    main(sys.argv[1])
