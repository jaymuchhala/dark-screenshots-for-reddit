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
  const allowed = (u) => IMAGE_HOSTS.has(new URL(u).hostname);
  if (!allowed(url)) return null;
  return withSlot(async () => {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) return null;
    const stats = await analyzeBlob(await res.blob());
    if (!fullUrl || !allowed(fullUrl) || !mayBePartial(stats)) return stats;
    try {
      const full = await fetch(fullUrl, { credentials: 'omit' });
      if (full.ok) stats.partial = await partialDarken(await full.blob());
    } catch {}
    return stats;
  });
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
  if (sender.id !== chrome.runtime.id) return;
  if (msg.type === 'check-build') checkBuild();
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
