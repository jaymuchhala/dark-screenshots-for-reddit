(() => {
  const IMAGE_HOSTS = new Set(['i.redd.it', 'preview.redd.it', 'external-preview.redd.it']);
  const MIN_WIDTH = 80, MIN_HEIGHT = 50;
  const REVEAL_AFTER_MS = 2500;
  const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
  const MAX_OVERRIDES = 500;
  const MAX_VIDEO_CHECKS = 2;
  const PLAYER_TRIES = 20, PLAYER_RETRY_MS = 500;

  let settings = { reader: true, readerMode: 'theme', videos: false, uploader: true, tinted: true };
  let overrides = {};
  const systemDark = matchMedia('(prefers-color-scheme: dark)');

  // ---------- Reader: darken screenshots already on the page ----------

  const verdicts = new Map();   // image key -> pixel stats or null, or a promise while checking
  const tracked = new Map();    // img -> { hidden, darkened, filter, visibility }
  const observedRoots = new WeakSet();
  let lastRightClicked = null;

  // A tab left open across an extension reload has no runtime, so it can't check images.
  const readerActive = (el) => chrome.runtime?.id && settings.reader && (el.localName !== 'video' || settings.videos) &&
    (settings.readerMode === 'always' || systemDark.matches);

  // Reddit's player keeps a tiny copy of the video in `preview`, and any page can read
  // its pixels. GIF posts have no preview, but their own file is readable. The scrubber's
  // thumbnail is a few shadow roots further in, and shares the verdict of its player.
  function videoUrl(video) {
    let player = video.getRootNode().host;
    while (player && !isPlayer(player)) player = player.getRootNode().host;
    if (!player) return null;
    return player.getAttribute('preview') || (player.hasAttribute('gif') && player.getAttribute('src')) || null;
  }

  const isPlayer = (el) => el.localName === 'shreddit-player' || el.localName === 'shreddit-player-2';

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

  function setHidden(img, state, hidden) {
    if (state.hidden === hidden) return;
    state.hidden = hidden;
    if (hidden) {
      state.visibility = img.style.getPropertyValue('visibility');
      img.style.setProperty('visibility', 'hidden', 'important');
    } else {
      img.style.removeProperty('visibility');
      if (state.visibility) img.style.setProperty('visibility', state.visibility);
    }
  }

  // `picture` is a partly dark copy of the image, shown in place of the original. CSS
  // `content` leaves the element, its sizing and any filter of the site's as they are.
  function setDarkened(img, state, dark, picture = null) {
    if (state.darkened === dark && state.picture === picture) return;
    if (state.darkened) {
      img.style.removeProperty('content');
      img.style.removeProperty('filter');
      if (state.filter) img.style.setProperty('filter', state.filter);
    }
    state.darkened = dark;
    state.picture = picture;
    if (dark && picture) {
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
    } else {
      img.style.removeProperty('filter');
      if (state.filter) img.style.setProperty('filter', state.filter);
      if (img.localName === 'video') {
        img.style.removeProperty('background-color');
        if (state.background) img.style.setProperty('background-color', state.background);
      }
    }
  }

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
      setDarkened(img, state, overrides[key], verdicts.get(key)?.partial || null);
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
      const picture = usesPartial(stats, settings.tinted) ? stats.partial : null;
      setDarkened(img, state, stats === true || !!picture || (!!stats && isLightScreenshot(stats, settings.tinted)), picture);
      setHidden(img, state, false);
      return true;
    }
    return false;
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
    const check = img.localName === 'video'
      ? withVideoSlot(() => isLightVideo(url))
      : chrome.runtime.sendMessage({ type: 'check-image', url: smallestUrl(img, url), fullUrl: largestUrl(img, url) });
    const pending = check
      .catch(() => null)
      .then((result) => {
        verdicts.set(key, result || null);
        for (const other of tracked.keys()) render(other);
      });
    verdicts.set(key, pending);
    return pending;
  }

  const viewport = new IntersectionObserver((entries) => {
    for (const { target: img, isIntersecting, boundingClientRect: box } of entries) {
      if (!isIntersecting) continue;
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
      setTimeout(() => setHidden(img, state, false), REVEAL_AFTER_MS);
      checkVerdict(img, url);
    }
  }, { rootMargin: '600px' });

  // Reddit can restore a feed from a saved copy of its markup, and an image can be
  // dropped from `tracked` and put back, so an image can arrive with these styles
  // already on it. Only this script sets them as important.
  function clearLeftovers(img) {
    for (const name of ['visibility', 'filter', 'background-color']) {
      if (img.style.getPropertyPriority(name) === 'important') img.style.removeProperty(name);
    }
  }

  function track(img) {
    if (!imageUrl(img)) return;
    let state = tracked.get(img);
    if (!state) {
      clearLeftovers(img);
      state = { hidden: false, darkened: false, filter: '', visibility: '', background: '' };
      tracked.set(img, state);
      viewport.observe(img);
    }
    // Hidden from the start so an unchecked screenshot never flashes white.
    if (!render(img) && readerActive(img)) setHidden(img, state, true);
  }

  const isMedia = (el) => el.localName === 'img' || el.localName === 'video';

  // The player's scripts load late, so a shadow root may not exist yet.
  function watchLate(el, tries = PLAYER_TRIES) {
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
        viewport.unobserve(img);
        tracked.delete(img);
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

  // Returns the files to hand to the page, dark where needed.
  async function convertFiles(files) {
    let changed = 0;
    const out = await Promise.all(files.map(async (file) => {
      // GIFs would lose their animation.
      if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > MAX_UPLOAD_BYTES) return file;
      try {
        if (!isLightScreenshot(await analyzeBlob(file), settings.tinted)) return file;
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
    if (changes.settings) settings = { ...settings, ...changes.settings.newValue };
    if (changes.overrides) overrides = changes.overrides.newValue || {};
    refreshAll();
  });

  chrome.storage.local.get(['settings', 'overrides']).then((stored) => {
    settings = { ...settings, ...stored.settings };
    overrides = stored.overrides || {};
    watchRoot(document);
  });

  // Lets the worker notice a new build.txt during development (see background.js).
  chrome.runtime.sendMessage({ type: 'check-build' }).catch(() => {});
})();
