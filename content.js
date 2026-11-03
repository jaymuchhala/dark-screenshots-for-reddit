(() => {
  const IMAGE_HOSTS = new Set(['i.redd.it', 'preview.redd.it', 'external-preview.redd.it']);
  const MIN_WIDTH = 80, MIN_HEIGHT = 50;
  const LABEL_MIN_WIDTH = 80, LABEL_MIN_HEIGHT = 60;
  const WAITING_INSET = 14, WAITING_MAX_BAR = 50;
  const REVEAL_AFTER_MS = 2500;
  const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
  const MAX_OVERRIDES = 500;
  const MAX_VIDEO_CHECKS = 2;
  const PLAYER_TRIES = 100, PLAYER_RETRY_MS = 100;
  const VIDEO_REVEAL_AFTER_MS = 6000;
  const AI_HOLD_MS = 45000;
  const AI_UPLOAD_WAIT_MS = 30000;
  const PARTS = 'parts';
  const PARTS_CHECK_MS = 100;
  const PARTS_MIN_LOOK_MS = 66;
  const PARTS_HOLD_LOOKS = 2;
  const PARTS_MAX_SHARP = 540;
  const NOTHING_SHOWN = 'inset(50%)';
  const PARTS_MIN_HEIGHT = 270;
  const MAX_SAVED_VIDEOS = 500;

  let settings = { reader: true, readerMode: 'theme', videos: false, frames: true, uploader: true, tinted: true };
  let overrides = {};
  let savedVideos = {};   // video key -> verdict, so a reload needs no new check
  const systemDark = matchMedia('(prefers-color-scheme: dark)');

  // ---------- Reader: darken screenshots already on the page ----------

  const verdicts = new Map();   // image key -> pixel stats or null, or a promise while checking
  const asking = new Map();     // image key -> when to stop holding it for the AI check
  const tracked = new Map();    // img -> { hidden, darkened, filter, held }
  const players = new Map();    // video player -> { hidden, held, timer, expired }
  const partVideos = new Map(); // video darkened in parts -> { ready, stop }
  const observedRoots = new WeakSet();
  let lastRightClicked = null;

  // A tab left open across an extension reload has no runtime, so it can't check images.
  const readerActive = (el) => chrome.runtime?.id && settings.reader && (el.localName === 'img' || settings.videos) &&
    (settings.readerMode === 'always' || systemDark.matches);

  // Reddit's player keeps a tiny copy of the video in `preview`, and any page can read
  // its pixels. GIF posts have no preview, but their own file is readable. The scrubber's
  // thumbnail is a few shadow roots further in, and shares the verdict of its player.
  function videoUrl(video) {
    const player = playerOf(video);
    return player ? playerUrl(player) : null;
  }

  function playerOf(el) {
    let player = el;
    while (player && !isPlayer(player)) player = player.getRootNode().host;
    return player;
  }

  const playerUrl = (player) => player.getAttribute('preview') || (player.hasAttribute('gif') && player.getAttribute('src')) || null;

  const isPlayer = (el) => el.localName === 'shreddit-player' || el.localName === 'shreddit-player-2';

  // The copy shown over the video has to look as sharp as the video does there.
  function sharpUrl(player, need) {
    try {
      const sources = JSON.parse(player.getAttribute('packaged-media-json')).playbackMp4s.permutations.map((p) => p.source);
      const side = (s) => Math.min(s.dimensions.width, s.dimensions.height);
      sources.sort((a, b) => side(a) - side(b));
      return (sources.find((s) => side(s) >= Math.min(PARTS_MAX_SHARP, need)) || sources.at(-1))?.url || null;
    } catch {
      return null;
    }
  }

  // The preview is too small to find the edges of a panel. The player's own <video> can't
  // be read, but the same files load fine with CORS.
  function largerUrl(player) {
    try {
      const sources = JSON.parse(player.getAttribute('packaged-media-json')).playbackMp4s.permutations.map((p) => p.source);
      const big = sources.filter((s) => Math.min(s.dimensions.width, s.dimensions.height) >= PARTS_MIN_HEIGHT);
      return big.sort((a, b) => a.bitrateBps - b.bitrateBps)[0]?.url || null;
    } catch {
      return null;
    }
  }

  // The elements between the player and the scrubber's thumbnail.
  const PLAYER_PARTS = new Set(['shreddit-media-ui', 'shreddit-progress-bar', 'shreddit-preview-video-lazy']);
  const loadsLate = (el) => isPlayer(el) || PLAYER_PARTS.has(el.localName);

  function imageUrl(img) {
    if (img.localName === 'video') return videoUrl(img);
    const url = img.currentSrc || img.src;
    try {
      return IMAGE_HOSTS.has(new URL(url).hostname) ? url : null;
    } catch {
      return null;
    }
  }

  // The same picture appears at several sizes, so the path is what identifies it.
  function imageKey(url) {
    const { hostname, pathname } = new URL(url);
    return hostname + pathname;
  }

  // Checking the smallest size in the srcset is enough and saves the download.
  function smallestUrl(img, fallback) {
    const first = (img.getAttribute('srcset') || '').split(',')[0].trim().split(/\s+/)[0];
    try {
      const url = new URL(first, location.href);
      if (first && IMAGE_HOSTS.has(url.hostname)) return url.href;
    } catch {}
    return fallback;
  }

  // The largest size, for an image that gets darkened in parts.
  function largestUrl(img, fallback) {
    const last = (img.getAttribute('srcset') || '').split(',').pop().trim().split(/\s+/)[0];
    try {
      const url = new URL(last, location.href);
      if (last && IMAGE_HOSTS.has(url.hostname)) return url.href;
    } catch {}
    return fallback;
  }

  // Where the waiting picture's icon goes, in from the top right corner of what's on show.
  // An ancestor can clip the box. A narrow bar beside a centered image looks like part of the
  // image, so the top matches the distance to the edge beyond the bar. A wide bar doesn't.
  function waitingInsets(el, box) {
    let top = 0, right = 0;
    for (let a = el.parentElement || el.getRootNode().host; a && a !== document.body; a = a.parentElement || a.getRootNode().host) {
      if (!/hidden|clip/.test(getComputedStyle(a).overflow)) continue;
      const clip = a.getBoundingClientRect();
      if (clip.bottom <= box.top || clip.top >= box.bottom || clip.right <= box.left || clip.left >= box.right) continue;
      top = Math.max(top, clip.top - box.top);
      right = Math.max(right, box.right - clip.right);
    }
    const parent = el.parentElement && el.parentElement !== document.body ? el.parentElement.getBoundingClientRect() : box;
    const bar = parent.right - box.right;
    const centered = bar > 0 && Math.abs(bar - (box.left - parent.left)) < 2;
    return { top: Math.round(top + WAITING_INSET + (centered && bar <= WAITING_MAX_BAR ? bar : 0)), right: Math.round(right + WAITING_INSET) };
  }

  // What a waiting image or video shows: the icon and "Dark mode..." over an empty box,
  // near its top right corner, the text on one line under the icon, squeezed to its width. Boxes too short for the text
  // get the icon alone. The dots step in time with the sweep: both run for 2s. The delay
  // keeps it from blinking when the wait is very short.
  function waitingPicture(el) {
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const box = el.getBoundingClientRect();
    const inset = waitingInsets(el, box);
    const label = !box.height || (box.width >= LABEL_MIN_WIDTH && box.height >= LABEL_MIN_HEIGHT);
    return 'url("data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
      <style>
        @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
        @keyframes pulse { from { transform: scale(1); } to { transform: scale(1.14); } }
        @keyframes second { 0% { fill-opacity: 0; } 25%, 100% { fill-opacity: 1; } }
        @keyframes third { 0% { fill-opacity: 0; } 50% { fill-opacity: 1; } 75%, 100% { fill-opacity: 0; } }
        g { animation: fade 0.2s ease-out 0.25s both; }
        text { font: 400 4.5px system-ui, -apple-system, sans-serif; fill: #d7dadc; }
        ${still ? '' : `.icon { transform-box: fill-box; transform-origin: center; animation: pulse 1.4s ease-in-out infinite alternate; }
        .second { animation: second 2s step-end infinite; }
        .third { animation: third 2s step-end infinite; }`}
      </style>
      <linearGradient id="sweep" gradientUnits="userSpaceOnUse" x2="32" y2="32" spreadMethod="repeat">
        <stop offset="0" stop-color="#f6f7f8"/><stop offset="0.25" stop-color="#181b1e"/><stop offset="0.5" stop-color="#f6f7f8"/><stop offset="0.75" stop-color="#181b1e"/><stop offset="1" stop-color="#f6f7f8"/>
        ${still ? '' : '<animateTransform attributeName="gradientTransform" type="translate" from="0" to="32" dur="2s" repeatCount="indefinite"/>'}
      </linearGradient>
      <g>
        <svg x="100%" y="${inset.top}" overflow="visible">
          <rect class="icon" x="${-inset.right - 20}" width="20" height="20" rx="4.5" fill="url(#sweep)"/>
          ${label ? `<text x="${-inset.right - 20}" y="27" textLength="20" lengthAdjust="spacingAndGlyphs">Dark mode.<tspan class="second">.</tspan><tspan class="third">.</tspan></text>` : ''}
        </svg>
      </g>
    </svg>`) + '")';
  }

  // Reddit stacks blurred, faded copies behind its images. The icon belongs on the image.
  const isBackdrop = (img) => /post-background-image-filter|blur-\[/.test(img.className) || getComputedStyle(img).filter !== 'none';

  // Moving the picture out of its own box hides it and leaves the box, with its
  // background, on show. `transparent` covers any placeholder color of the site's.
  function holdStyles(el) {
    if (el.localName === 'shreddit-player') return { visibility: 'hidden', '--dark-screenshots-waiting': waitingPicture(el) };
    if (el.localName !== 'img' || isBackdrop(el)) return { visibility: 'hidden' };
    return {
      'object-position': '-99999px -99999px',
      'background-color': 'transparent',
      'background-image': waitingPicture(el),
      'background-position': '0 0',
      'background-size': '100% 100%',
      'background-repeat': 'no-repeat',
    };
  }

  // Reddit lays an image out again as it loads, so the picture follows its box and parent.
  function followLayout(el, state) {
    const name = el.localName === 'img' ? 'background-image' : '--dark-screenshots-waiting';
    if (!(name in holdStyles(el))) return;
    state.waiting = el.style.getPropertyValue(name);
    state.layout = new ResizeObserver(() => {
      const picture = waitingPicture(el);
      if (picture === state.waiting) return;
      state.waiting = picture;
      el.style.setProperty(name, picture, 'important');
    });
    state.layout.observe(el);
    if (el.parentElement) state.layout.observe(el.parentElement);
  }

  function setHidden(img, state, hidden) {
    if (state.hidden === hidden) return;
    state.hidden = hidden;
    if (hidden) {
      state.held = {};
      for (const [name, value] of Object.entries(holdStyles(img))) {
        state.held[name] = img.style.getPropertyValue(name);
        img.style.setProperty(name, value, 'important');
      }
      followLayout(img, state);
    } else {
      state.layout?.disconnect();
      for (const [name, value] of Object.entries(state.held)) {
        img.style.removeProperty(name);
        if (value) img.style.setProperty(name, value);
      }
    }
  }

  // `picture` is a partly dark copy of the image, shown in place of the original. CSS
  // `content` leaves the element, its sizing and any filter of the site's as they are.
  function setDarkened(img, state, dark, picture = null) {
    if (!dark) picture = null;
    if (state.darkened === dark && state.picture === picture) return;
    if (state.picture === PARTS) {
      stopParts(img);
    } else if (state.picture) {
      img.style.removeProperty('content');
    } else if (state.darkened) {
      img.style.removeProperty('filter');
      if (state.filter) img.style.setProperty('filter', state.filter);
      if (img.localName === 'video') {
        img.style.removeProperty('background-color');
        if (state.background) img.style.setProperty('background-color', state.background);
      }
    }
    state.darkened = dark;
    state.picture = picture;
    if (picture === PARTS) {
      startParts(img);
    } else if (picture) {
      img.style.setProperty('content', `url("${picture}")`, 'important');
    } else if (dark) {
      state.filter = img.style.getPropertyValue('filter');
      // Keep any filter the site has, such as the blur on Reddit's post backdrop.
      const current = getComputedStyle(img).filter;
      img.style.setProperty('filter', `${current === 'none' ? '' : current + ' '}${DARK_FILTER}`, 'important');
      // The filter also covers the player's black bars beside a tall video, turning
      // them almost white. A white background comes out dark instead.
      if (img.localName === 'video') {
        state.background = img.style.getPropertyValue('background-color');
        img.style.setProperty('background-color', '#fff', 'important');
      }
    }
  }

  // A second copy of the video, darkened and cut down to the light parts of its own frames,
  // sits on the real one. Picture and cut come from the same frame, so they stay together
  // however fast the parts move. It sits under the player's controls.
  function startParts(video) {
    const player = video.getRootNode().host;
    if (!player || !isPlayer(player)) return;
    const box = video.getBoundingClientRect();
    const url = sharpUrl(player, Math.min(box.width, box.height) * devicePixelRatio);
    if (!url) return;
    video.parentNode.querySelector('[data-dark-parts]')?.remove();
    const copy = document.createElement('video');
    copy.setAttribute('data-dark-parts', '');
    copy.setAttribute('aria-hidden', 'true');
    copy.crossOrigin = 'anonymous';
    copy.muted = true;
    copy.playsInline = true;
    copy.preload = 'auto';
    copy.style.cssText = `position:absolute;left:0;top:0;margin:0;max-width:none;max-height:none;pointer-events:none;filter:${DARK_FILTER};clip-path:${NOTHING_SHOWN}`;
    copy.src = url;
    video.after(copy);
    let ctx = null, stopped = false, frame = 0, seen = -1, lastLook = 0, misses = 0, shown = [], left = 0, top = 0;

    const finish = () => {
      if (state.ready) return;
      state.ready = true;
      updatePlayer(player);
    };

    const paint = () => {
      const box = video.getBoundingClientRect(), at = copy.getBoundingClientRect(), css = getComputedStyle(video);
      // The copy's containing block isn't known, so it's moved by however far off it is.
      if (Math.abs(box.left - at.left) > 0.5) copy.style.left = `${left += box.left - at.left}px`;
      if (Math.abs(box.top - at.top) > 0.5) copy.style.top = `${top += box.top - at.top}px`;
      copy.style.width = `${box.width}px`;
      copy.style.height = `${box.height}px`;
      copy.style.objectFit = css.objectFit;
      copy.style.borderRadius = css.borderRadius;
      const fit = css.objectFit === 'cover' ? Math.max : Math.min;
      const scale = fit(box.width / ctx.canvas.width, box.height / ctx.canvas.height);
      const padX = (box.width - ctx.canvas.width * scale) / 2, padY = (box.height - ctx.canvas.height * scale) / 2;
      // Rows of the same width share a box, and they overlap a little so no line shows between them.
      const path = shown.map((r) => `M${padX + r.x * scale - 0.5} ${padY + r.y * scale - 0.5}h${r.w * scale + 1}v${r.h * scale + 1}h${-r.w * scale - 1}z`).join('');
      copy.style.clipPath = path ? `path("${path}")` : NOTHING_SHOWN;
    };

    const look = () => {
      if (stopped || copy.readyState < 2 || copy.seeking || !copy.videoWidth) return;
      const scale = Math.min(1, VIDEO_PART_SIZE / Math.max(copy.videoWidth, copy.videoHeight));
      ctx ??= new OffscreenCanvas(Math.round(copy.videoWidth * scale), Math.round(copy.videoHeight * scale)).getContext('2d', { willReadFrequently: true });
      const { width, height } = ctx.canvas;
      ctx.drawImage(copy, 0, 0, width, height);
      seen = copy.currentTime;
      lastLook = performance.now();
      const rects = lightMask(ctx.getImageData(0, 0, width, height).data, width, height);
      // A frame or two can miss the parts as they move, and that shouldn't flash light.
      if (rects.length || ++misses > PARTS_HOLD_LOOKS) {
        shown = rects;
        misses = 0;
      }
      paint();
      finish();
    };

    const onFrame = () => {
      if (stopped) return;
      if (performance.now() - lastLook >= PARTS_MIN_LOOK_MS) look();
      frame = copy.requestVideoFrameCallback(onFrame);
    };

    // Keeps the copy on the real video's time. Only runs the frame checks while paused.
    const tick = () => {
      const box = video.getBoundingClientRect();
      if (document.hidden || box.bottom < 0 || box.top > innerHeight) return copy.pause();
      const behind = video.currentTime - copy.currentTime;
      if (Math.abs(behind) > 0.3) copy.currentTime = video.currentTime;
      if (video.paused) {
        copy.pause();
        if (Math.abs(behind) <= 0.3 && copy.currentTime !== seen) look();
        else if (ctx) paint();
        return;
      }
      // A small nudge catches up without the stall of a seek.
      copy.playbackRate = video.playbackRate * (1 + Math.max(-0.1, Math.min(0.1, behind)));
      if (copy.paused) copy.play().catch(() => {});
      if (ctx) paint();
    };

    const timer = setInterval(tick, PARTS_CHECK_MS);
    frame = copy.requestVideoFrameCallback(onFrame);
    // While it seeks the copy still shows the old frame, which may be nothing like the new one.
    copy.addEventListener('seeking', () => {
      copy.style.clipPath = NOTHING_SHOWN;
    });
    copy.addEventListener('seeked', look);
    // A link can expire, and these files only allow www.reddit.com. Then the video stays as it is.
    copy.addEventListener('error', () => {
      stop();
      finish();
    });
    const stop = () => {
      stopped = true;
      clearInterval(timer);
      copy.cancelVideoFrameCallback(frame);
      copy.removeAttribute('src');
      copy.load();
      copy.remove();
      if (partVideos.get(video) === state) partVideos.delete(video);
    };
    const state = { ready: false, stop };
    partVideos.set(video, state);
  }

  const stopParts = (video) => partVideos.get(video)?.stop();

  // Applies what's known about an image. Returns false if its verdict is still needed.
  function render(img) {
    const state = tracked.get(img);
    const url = imageUrl(img);
    if (!state) return true;
    if (!url) {
      setHidden(img, state, false);
      setDarkened(img, state, false);
      return true;
    }
    const key = imageKey(url);
    if (key in overrides) {
      setHidden(img, state, false);
      const known = verdicts.get(key);
      setDarkened(img, state, overrides[key], known === PARTS ? PARTS : known?.partial || known?.vetoedPartial || null);
      return true;
    }
    if (!readerActive(img)) {
      setHidden(img, state, false);
      setDarkened(img, state, false);
      return true;
    }
    const stats = verdicts.get(key);
    if (stats === null || (stats && !(stats instanceof Promise))) {
      // A video's verdict is already true or null. An image's depends on the settings.
      const picture = stats === PARTS ? PARTS : usesPartial(stats, settings.tinted, settings.frames) ? stats.partial : null;
      setDarkened(img, state, stats === true || !!picture || (!!stats && isLightScreenshot(stats, settings.tinted)), picture);
      setHidden(img, state, false);
      return true;
    }
    return false;
  }

  // A player stays hidden as a whole until its video has the filter, since its scripts
  // can draw the video or its poster before this script sees them.
  function holdPlayer(player) {
    if (players.has(player) || !playerUrl(player)) return;
    clearLeftovers(player);
    players.set(player, { hidden: false, held: {}, timer: null, expired: false });
    viewport.observe(player);
    updatePlayer(player);
  }

  function updatePlayer(player) {
    const state = players.get(player);
    if (!state) return;
    const key = imageKey(playerUrl(player));
    const dark = key in overrides ? overrides[key] : readerActive(player) && verdicts.get(key) !== null;
    const video = player.shadowRoot?.querySelector('video');
    const ready = tracked.get(video)?.darkened && partVideos.get(video)?.ready !== false;
    const hold = dark && !ready && !state.expired;
    setHidden(player, state, hold);
    player.toggleAttribute('data-applying-dark', hold);   // Shows the waiting picture, through content.css.
  }

  let videoChecks = 0;
  const videoQueue = [];

  async function withVideoSlot(job) {
    if (videoChecks >= MAX_VIDEO_CHECKS) await new Promise((resolve) => videoQueue.push(resolve));
    videoChecks++;
    try {
      return await job();
    } finally {
      videoChecks--;
      videoQueue.shift()?.();
    }
  }

  function checkVerdict(img, url) {
    const key = imageKey(url);
    if (verdicts.has(key)) return verdicts.get(key);
    const check = img.localName !== 'img'
      ? videoVerdict(key, url, img)
      : chrome.runtime.sendMessage({ type: 'check-image', key, url: smallestUrl(img, url), fullUrl: largestUrl(img, url) })
        .then((stats) => stats?.askAi && !(key in overrides) ? askAboutImage(key, stats, largestUrl(img, url)) : stats);
    const pending = check
      .catch(() => null)
      .then((result) => {
        verdicts.set(key, result || null);
        for (const other of tracked.keys()) render(other);
        for (const player of players.keys()) updatePlayer(player);
      });
    verdicts.set(key, pending);
    return pending;
  }

  // The AI check has the last word on what the pixel checks would darken. The image stays
  // held meanwhile, unless the queue is very long. No answer leaves the verdict as it is.
  async function askAi(key, message) {
    asking.set(key, Date.now() + AI_HOLD_MS);
    try {
      return await chrome.runtime.sendMessage({ type: 'ask-ai', ...message });
    } catch {
      return null;
    } finally {
      asking.delete(key);
    }
  }

  async function askAboutImage(key, stats, url) {
    if (await askAi(key, { key, url }) !== false) return stats;
    return { ...stats, photo: 1, partial: null, vetoedPartial: stats.partial };
  }

  // What's saved is the pixel checks' verdict, so the AI check can change its mind on it later.
  async function videoVerdict(key, url, player) {
    const pixels = key in savedVideos ? savedVideos[key] : await withVideoSlot(() => checkVideo(url, largerUrl(playerOf(player))));
    if (pixels !== null && !(key in savedVideos)) saveVideoVerdict(key, pixels);
    return pixels === true ? askAboutVideo(key, player) : pixels;
  }

  async function askAboutVideo(key, player) {
    const known = await chrome.runtime.sendMessage({ type: 'ai-known', key }).catch(() => null);
    if (known !== 'ask') return known !== false;
    const url = largerUrl(playerOf(player));
    const image = url && await aiVideoFrame(url);
    if (!image) return true;
    return await askAi(key, { key, image }) !== false;
  }

  // Reveals after a while, or once the AI check is done with the image.
  function revealLater(url, ms, reveal) {
    setTimeout(() => {
      if (url && asking.get(imageKey(url)) > Date.now()) revealLater(url, 500, reveal);
      else reveal();
    }, ms);
  }

  function saveVideoVerdict(key, verdict) {
    savedVideos[key] = verdict;
    const keys = Object.keys(savedVideos);
    if (keys.length > MAX_SAVED_VIDEOS) delete savedVideos[keys[0]];
    chrome.storage.local.set({ videoChecks: savedVideos });
  }

  const viewport = new IntersectionObserver((entries) => {
    for (const { target: img, isIntersecting, boundingClientRect: box } of entries) {
      if (!isIntersecting) continue;
      const held = players.get(img);
      if (held) {
        if (!held.hidden) continue;
        if (!held.timer) {
          held.timer = true;
          revealLater(playerUrl(img), VIDEO_REVEAL_AFTER_MS, () => {
            held.expired = true;
            updatePlayer(img);
          });
        }
        if (readerActive(img)) checkVerdict(img, playerUrl(img));
        continue;
      }
      const state = tracked.get(img);
      if (!state) continue;
      if (box.width < MIN_WIDTH || box.height < MIN_HEIGHT) {
        setHidden(img, state, false);
        continue;
      }
      const url = imageUrl(img);
      if (render(img)) {
        // Turned on by hand, an image still needs its verdict to know if it's darkened in parts.
        if (url && img.localName === 'img' && overrides[imageKey(url)] && chrome.runtime?.id) checkVerdict(img, url);
        continue;
      }
      revealLater(url, img.localName === 'video' ? VIDEO_REVEAL_AFTER_MS : REVEAL_AFTER_MS, () => setHidden(img, state, false));
      checkVerdict(img, url);
    }
  }, { rootMargin: '600px' });

  // Reddit can restore a feed from a saved copy of its markup, and an image can be
  // dropped from `tracked` and put back, so an image can arrive with these styles
  // already on it. Only this script sets them as important.
  function clearLeftovers(img) {
    for (const name of ['visibility', 'filter', 'object-position', 'background-color', 'background-image', 'background-position', 'background-size', 'background-repeat']) {
      if (img.style.getPropertyPriority(name) === 'important') img.style.removeProperty(name);
    }
  }

  function track(img) {
    if (!imageUrl(img)) return;
    let state = tracked.get(img);
    if (!state) {
      clearLeftovers(img);
      state = { hidden: false, darkened: false, filter: '', held: {}, background: '' };
      tracked.set(img, state);
      viewport.observe(img);
    }
    // Hidden from the start so an unchecked screenshot never flashes white.
    if (!render(img) && readerActive(img)) setHidden(img, state, true);
    updatePlayer(img.getRootNode().host);
  }

  const isMedia = (el) => el.localName === 'img' || (el.localName === 'video' && !el.hasAttribute('data-dark-parts'));

  // The player's scripts load late, so a shadow root may not exist yet.
  function watchLate(el, tries = PLAYER_TRIES) {
    if (isPlayer(el)) holdPlayer(el);
    if (el.shadowRoot) watchRoot(el.shadowRoot);
    else if (tries && el.isConnected) setTimeout(() => watchLate(el, tries - 1), PLAYER_RETRY_MS);
  }

  function scan(node) {
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE && node.nodeType !== Node.DOCUMENT_NODE) return;
    if (node.nodeType === Node.ELEMENT_NODE && isMedia(node)) track(node);
    if (node.nodeType === Node.ELEMENT_NODE && loadsLate(node)) watchLate(node);
    if (node.shadowRoot) watchRoot(node.shadowRoot);
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const el = walker.currentNode;
      if (isMedia(el)) track(el);
      else if (loadsLate(el)) watchLate(el);
      else if (el.shadowRoot) watchRoot(el.shadowRoot);
    }
  }

  function prune() {
    for (const img of tracked.keys()) {
      if (!img.isConnected) {
        stopParts(img);
        viewport.unobserve(img);
        tracked.delete(img);
      }
    }
    for (const player of players.keys()) {
      if (!player.isConnected) {
        viewport.unobserve(player);
        players.delete(player);
      }
    }
  }

  const mutations = new MutationObserver((records) => {
    let removed = false;
    for (const record of records) {
      if (record.type === 'attributes') {
        if (record.target.localName !== 'img') continue;
        const state = tracked.get(record.target);
        if (state) {
          // A new picture starts over.
          setDarkened(record.target, state, false);
          viewport.unobserve(record.target);
          viewport.observe(record.target);
        }
        track(record.target);
      } else {
        record.addedNodes.forEach(scan);
        if (record.removedNodes.length) removed = true;
      }
    }
    if (removed) prune();
  });

  function watchRoot(root) {
    if (observedRoots.has(root)) return;
    observedRoots.add(root);
    mutations.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset'] });
    scan(root);
  }

  function refreshAll() {
    for (const img of tracked.keys()) {
      viewport.unobserve(img);
      viewport.observe(img);
      if (!render(img) && readerActive(img)) setHidden(img, tracked.get(img), true);
    }
    for (const player of players.keys()) {
      updatePlayer(player);
      viewport.unobserve(player);
      viewport.observe(player);
    }
  }

  systemDark.addEventListener('change', refreshAll);

  // Lazy images get a final URL from srcset only once they load. An image can also
  // have been too small to check until now, so it needs a fresh look at its size.
  document.addEventListener('load', (e) => {
    if (e.target.localName !== 'img') return;
    if (tracked.has(e.target)) {
      viewport.unobserve(e.target);
      viewport.observe(e.target);
    }
    track(e.target);
  }, true);

  // ---------- Right-click override ----------

  window.addEventListener('contextmenu', (e) => {
    const el = e.composedPath()[0];
    lastRightClicked = el && isMedia(el) ? el : null;
  }, true);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'toggle-image' || !lastRightClicked) return;
    const url = imageUrl(lastRightClicked);
    if (!url) return;
    track(lastRightClicked);
    const key = imageKey(url);
    overrides[key] = !tracked.get(lastRightClicked).darkened;
    const keys = Object.keys(overrides);
    if (keys.length > MAX_OVERRIDES) delete overrides[keys[0]];
    chrome.storage.local.set({ overrides });
    for (const img of tracked.keys()) render(img);
    for (const player of players.keys()) updatePlayer(player);
  });

  // ---------- Uploader: swap screenshots for dark copies before the page gets them ----------

  function notify(count) {
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>div{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;padding:8px 14px;border-radius:8px;background:#1f2326;color:#f2f4f5;font:13px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.35)}</style><div></div>`;
    root.querySelector('div').textContent = count > 1 ? `${count} screenshots made dark` : 'Screenshot made dark';
    document.documentElement.append(host);
    setTimeout(() => host.remove(), 2500);
  }

  // The upload can't wait as long as an image on the page can.
  async function isAiVeto(file) {
    if (settings.aiEngine === 'off') return false;
    const ask = chrome.runtime.sendMessage({ type: 'ask-ai', image: await aiImage(file) });
    const late = new Promise((resolve) => setTimeout(resolve, AI_UPLOAD_WAIT_MS, null));
    return await Promise.race([ask, late]) === false;
  }

  // Returns the files to hand to the page, dark where needed.
  async function convertFiles(files) {
    let changed = 0;
    const out = await Promise.all(files.map(async (file) => {
      // GIFs would lose their animation.
      if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > MAX_UPLOAD_BYTES) return file;
      try {
        const stats = await analyzeBlob(file);
        if (!isLightScreenshot(stats, settings.tinted) || (mayBePalePhoto(stats) && await isPalePhoto(file))) return file;
        if (await isAiVeto(file)) return file;
        const dark = await darkenBlob(file);
        changed++;
        return new File([dark], file.name, { type: dark.type, lastModified: file.lastModified });
      } catch {
        return file;
      }
    }));
    if (changed) notify(changed);
    return out;
  }

  function toTransfer(files, strings = {}) {
    const transfer = new DataTransfer();
    for (const [type, value] of Object.entries(strings)) transfer.items.add(value, type);
    for (const file of files) transfer.items.add(file);
    return transfer;
  }

  const hasImage = (files) => files.some((file) => file.type.startsWith('image/'));

  // Reddit's input lives in a shadow root, and `change` doesn't leave a shadow root
  // while `input` does, so `input` is the event to catch here.
  window.addEventListener('input', (e) => {
    const input = e.composedPath()[0];
    if (!settings.uploader || !e.isTrusted || input?.localName !== 'input' || input.type !== 'file') return;
    const files = [...input.files];
    if (!hasImage(files)) return;
    e.stopImmediatePropagation();
    input.addEventListener('change', (change) => {
      if (change.isTrusted) change.stopImmediatePropagation();
    }, { capture: true, once: true });
    convertFiles(files).then((converted) => {
      input.files = toTransfer(converted).files;
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }, true);

  window.addEventListener('paste', (e) => {
    if (!settings.uploader || !e.isTrusted || !e.clipboardData) return;
    const files = [...e.clipboardData.files];
    // Text in the clipboard means this is a normal paste that happens to have an image.
    if (!hasImage(files) || e.clipboardData.types.includes('text/plain')) return;
    const target = e.composedPath()[0];
    const html = e.clipboardData.getData('text/html');
    e.preventDefault();
    e.stopImmediatePropagation();
    convertFiles(files).then((converted) => {
      const clipboardData = toTransfer(converted, html ? { 'text/html': html } : {});
      target.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true, composed: true }));
    });
  }, true);

  window.addEventListener('drop', (e) => {
    if (!settings.uploader || !e.isTrusted || !e.dataTransfer) return;
    const target = e.composedPath()[0];
    // A drop right on a file input comes back through its `input` event.
    if (target.localName === 'input' && target.type === 'file') return;
    const files = [...e.dataTransfer.files];
    if (!hasImage(files)) return;
    const { clientX, clientY, screenX, screenY } = e;
    e.preventDefault();
    e.stopImmediatePropagation();
    convertFiles(files).then((converted) => {
      target.dispatchEvent(new DragEvent('drop', {
        dataTransfer: toTransfer(converted), clientX, clientY, screenX, screenY,
        bubbles: true, cancelable: true, composed: true,
      }));
    });
  }, true);

  // ---------- Start ----------

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.videoChecks) savedVideos = changes.videoChecks.newValue || {};
    if (!changes.settings && !changes.overrides) return;
    if (changes.settings) settings = { ...settings, ...changes.settings.newValue };
    if (changes.overrides) overrides = changes.overrides.newValue || {};
    refreshAll();
  });

  // Verdicts from before videos could be darkened in parts have to be checked again.
  chrome.storage.local.remove('videoVerdicts');
  chrome.storage.local.get(['settings', 'overrides', 'videoChecks']).then((stored) => {
    settings = { ...settings, ...stored.settings };
    overrides = stored.overrides || {};
    savedVideos = stored.videoChecks || {};
    for (const [key, verdict] of Object.entries(savedVideos)) if (verdict !== true) verdicts.set(key, verdict || null);
    watchRoot(document);
  });

  // Lets the worker notice a new build.txt during development (see background.js).
  chrome.runtime.sendMessage({ type: 'check-build' }).catch(() => {});
})();
