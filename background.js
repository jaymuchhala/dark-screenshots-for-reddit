importScripts('detect.js');

const IMAGE_HOSTS = new Set(['i.redd.it', 'preview.redd.it', 'external-preview.redd.it']);
const MAX_FETCHES = 4;
const MENU_ID = 'toggle-dark';

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
async function checkImage(url) {
  if (!IMAGE_HOSTS.has(new URL(url).hostname)) return false;
  return withSlot(async () => {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) return false;
    return (await analyzeBlob(await res.blob())).screenshot;
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
  if (msg.type === 'menu-visible') chrome.contextMenus.update(MENU_ID, { visible: msg.visible }).catch(() => {});
  if (msg.type !== 'check-image') return;
  checkImage(msg.url).then(reply, () => reply(false));
  return true;
});

// Reddit lays links over its post images, and Chrome then reports a link or the page
// instead of an image, so the 'image' context alone would miss them. The content script
// hides the item while the pointer isn't over an image.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: 'Switch dark mode for this image',
      contexts: ['page', 'link', 'image'],
      documentUrlPatterns: ['https://*.reddit.com/*', 'https://reddit.com/*'],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID) {
    chrome.tabs.sendMessage(tab.id, { type: 'toggle-image' }, { frameId: info.frameId }).catch(() => {});
  }
});
