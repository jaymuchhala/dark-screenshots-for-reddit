importScripts('detect.js');

const IMAGE_HOSTS = new Set(['i.redd.it', 'preview.redd.it', 'external-preview.redd.it']);
const MAX_FETCHES = 4;
let running = 0;
const waiting = [];

async function withSlot(job) {
  if (running >= MAX_FETCHES) await new Promise((resolve) => waiting.push(resolve));
  running++;
  try {
    return await job();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

// The page can't read the pixels of images from another host, but the worker can.
async function checkImage(url, fullUrl) {
  if (!allowedImage(url)) return null;
  return inspectImage(url, fullUrl);
}

const allowedImage = (u) => IMAGE_HOSTS.has(new URL(u).hostname);

async function inspectImage(url, fullUrl) {
  return withSlot(async () => {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) return null;
    const blob = await res.blob();
    const stats = await analyzeBlob(blob);
    await checkFullSize(stats, fullUrl);
    // What the pixel checks would darken goes to the model, which can only say no. A no keeps the
    // partial copy, for the right-click override.
    if (!stats.partial && !isLightScreenshot(stats, (await readSettings()).tinted ?? true)) return stats;
    if (await isScreen(await screenPixels(blob)) !== false) return stats;
    return { ...stats, photo: 1, partial: null, vetoedPartial: stats.partial };
  });
}

async function checkFullSize(stats, fullUrl) {
  const framed = mayBeFrame(stats);
  const page = framed || mayBePartial(stats);
  if (fullUrl && allowedImage(fullUrl) && !page && mayBePalePhoto(stats)) {
    try {
      const full = await fetch(fullUrl, { credentials: 'omit' });
      if (full.ok && await isPalePhoto(await full.blob())) stats.photo = 1;
    } catch {}
    return;
  }
  if (!fullUrl || !allowedImage(fullUrl) || !(page || stats.around)) return;
  try {
    const full = await fetch(fullUrl, { credentials: 'omit' });
    if (full.ok && page) stats.partial = await partialDarken(await full.blob(), framed ? isFrameScreenshot : undefined);
    else if (full.ok) {
      stats.partial = await darkenAroundPanel(await full.blob(), stats.around);
      stats.panelled = !!stats.partial;
    }
    stats.framed = framed;
  } catch {}
}

async function readSettings() {
  return (await chrome.storage.local.get('settings')).settings || {};
}

// ---------- The model, which can stop an image from being darkened ----------

let offscreenReady = null;
async function openOffscreen() {
  offscreenReady ??= (async () => {
    if (await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['DOM_PARSER'],
      justification: 'Run the on-device models that tell screen captures from other images and find people in video',
    });
  })().finally(() => { offscreenReady = null; });
  await offscreenReady;
}

async function toOffscreen(msg) {
  await openOffscreen();
  return chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
}

// null: no answer, so the pixel checks decide.
async function isScreen(pixels) {
  return toOffscreen({ type: 'is-screen', pixels }).catch(() => null);
}

// Development: when loaded unpacked (no update_url), reload when build.txt changes,
// so edits on disk take effect without a trip to chrome://extensions. Each page load
// pings the worker to trigger the check. The stamp seen at load is kept in session
// storage, which outlives the worker going idle but is cleared by a reload.
async function checkBuild() {
  if ('update_url' in chrome.runtime.getManifest()) return;
  try {
    const stamp = (await (await fetch(chrome.runtime.getURL('build.txt'), { cache: 'no-store' })).text()).trim();
    const { build } = await chrome.storage.session.get('build');
    if (build === undefined) await chrome.storage.session.set({ build: stamp });
    else if (stamp !== build) chrome.runtime.reload();
  } catch (_) { /* no build.txt */ }
}
checkBuild();

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || msg.target) return;
  if (msg.type === 'check-build') checkBuild();
  if (msg.type === 'is-screen') {
    isScreen(msg.pixels).then(reply);
    return true;
  }
  // A video's people go straight to the page from the tab, many times a second.
  if (msg.type === 'open-offscreen') {
    openOffscreen().then(() => reply(true), () => reply(false));
    return true;
  }
  if (msg.type !== 'check-image') return;
  checkImage(msg.url, msg.fullUrl).then(reply, () => reply(null));
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'toggle-dark',
      title: 'Change dark mode',
      contexts: ['image'],
      documentUrlPatterns: ['https://*.reddit.com/*', 'https://reddit.com/*'],
    });
    chrome.contextMenus.create({
      id: 'toggle-dark-video',
      title: 'Change dark mode',
      contexts: ['video'],
      documentUrlPatterns: ['https://*.reddit.com/*', 'https://reddit.com/*'],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'toggle-dark' || info.menuItemId === 'toggle-dark-video') {
    chrome.tabs.sendMessage(tab.id, { type: 'toggle-image' }, { frameId: info.frameId }).catch(() => {});
  }
});
