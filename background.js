importScripts('detect.js');

const IMAGE_HOSTS = new Set(['i.redd.it', 'preview.redd.it', 'external-preview.redd.it']);
const MAX_FETCHES = 4;
const AI_TIMEOUT_MS = 30000;
const AI_REST_FACTOR = 6;      // after each call the model rests 6 times as long, so it's busy 1/7 of the time at most
const AI_REST_MIN_MS = 3000;
const AI_REST_MAX_MS = 90000;
const AI_PICK_MS = 30000;      // how long to trust which engine is ready
const AI_VERSION = 1;          // raise when the prompt changes, so old answers go
const MAX_AI_ANSWERS = 2000;

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
async function checkImage(url, fullUrl, key) {
  if (!allowedImage(url)) return null;
  const stats = await inspectImage(url, fullUrl);
  if (!stats || !(stats.partial || isLightScreenshot(stats, (await readSettings()).tinted ?? true))) return stats;
  stats.ai = await aiKnown(key).catch(() => null);
  return stats;
}

const allowedImage = (u) => IMAGE_HOSTS.has(new URL(u).hostname);

async function inspectImage(url, fullUrl) {
  const allowed = allowedImage;
  return withSlot(async () => {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) return null;
    const stats = await analyzeBlob(await res.blob());
    const framed = mayBeFrame(stats);
    const page = framed || mayBePartial(stats);
    if (fullUrl && allowed(fullUrl) && !page && mayBePalePhoto(stats)) {
      try {
        const full = await fetch(fullUrl, { credentials: 'omit' });
        if (full.ok && await isPalePhoto(await full.blob())) stats.photo = 1;
      } catch {}
      return stats;
    }
    if (!fullUrl || !allowed(fullUrl) || !(page || stats.around)) return stats;
    try {
      const full = await fetch(fullUrl, { credentials: 'omit' });
      if (full.ok && page) stats.partial = await partialDarken(await full.blob(), framed ? isFrameScreenshot : undefined);
      else if (full.ok) {
        stats.partial = await darkenAroundPanel(await full.blob(), stats.around);
        stats.panelled = !!stats.partial;
      }
      stats.framed = framed;
    } catch {}
    return stats;
  });
}

async function readSettings() {
  return (await chrome.storage.local.get('settings')).settings || {};
}

// ---------- The AI check, which can stop an image from being darkened ----------

let offscreenReady = null;
async function toOffscreen(msg) {
  offscreenReady ??= (async () => {
    if (await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['DOM_PARSER'],
      justification: 'Run the on-device model that tells screen captures from other images',
    });
  })().finally(() => { offscreenReady = null; });
  await offscreenReady;
  return chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
}

let aiPicked = null;
let aiPickedAt = 0;
async function aiPick() {
  const choice = (await readSettings()).aiEngine ?? 'off';
  if (choice === 'off') return null;
  if (Date.now() - aiPickedAt > AI_PICK_MS) {
    aiPicked = await toOffscreen({ type: 'ai-pick', choice });
    aiPickedAt = Date.now();
  }
  return aiPicked;
}

// Saved answers, so each image is asked about once.
let aiAnswers = null;
async function loadAnswers() {
  if (!aiAnswers) {
    const saved = (await chrome.storage.local.get('aiAnswers')).aiAnswers;
    aiAnswers = saved?.version === AI_VERSION ? saved.seen : {};
  }
  return aiAnswers;
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings) aiPickedAt = 0;
  if (changes.aiAnswers && !changes.aiAnswers.newValue) aiAnswers = null;
});

async function aiCanAnswer(key) {
  try {
    if (((await readSettings()).aiEngine ?? 'off') === 'off') return false;
    return key in await loadAnswers() || !!await aiPick();
  } catch {
    return false;
  }
}

// The saved answer if there is one, 'ask' if the AI can be asked, null if not.
async function aiKnown(key) {
  if (!await aiCanAnswer(key)) return null;
  const answers = await loadAnswers();
  return key in answers ? answers[key] : 'ask';
}

// One at a time, newest first.
const aiQueue = [];
let aiRunning = null;
function nextAiJob() {
  if (aiRunning || !aiQueue.length) return;
  aiRunning = aiQueue.pop();
  aiRunning.run().finally(() => {
    aiRunning = null;
    nextAiJob();
  });
}

// The page in that tab moved, so its model calls make way. Uploads stay.
function cancelAi(tab) {
  for (let i = aiQueue.length - 1; i >= 0; i--) {
    if (aiQueue[i].tab === tab) aiQueue.splice(i, 1)[0].resolve('cancelled');
  }
  if (aiRunning?.tab !== tab) return;
  aiRunning.cancelled = true;
  aiRunning.resolve('cancelled');
  toOffscreen({ type: 'ai-cancel' }).catch(() => {});
}

// True if the image is a screen, false if not, null if there's no answer, 'cancelled' if the
// page moved, or { restMs } if the model is resting. An image comes as a data URL, or as a url
// to fetch. Images on the page have a key and wait out the rest; an upload is someone waiting.
function askAi({ key, url, image }, tab) {
  return new Promise((resolve) => {
    const job = { tab: key ? tab : null, resolve, cancelled: false };
    aiQueue.push(job);
    job.run = async () => {
      if (job.cancelled) return;
      try {
        const answers = await loadAnswers();
        if (key && key in answers) return resolve(answers[key]);
        const pick = await aiPick();
        if (!pick) return resolve(null);
        if (key) {
          const { aiRestUntil = 0 } = await chrome.storage.session.get('aiRestUntil');
          if (aiRestUntil > Date.now()) return resolve({ restMs: aiRestUntil - Date.now() });
        }
        if (url && !allowedImage(url)) return resolve(null);
        const sent = image || await aiImage(await (await fetch(url, { credentials: 'omit' })).blob());
        const started = Date.now();
        const screen = await toOffscreen({ type: 'ai-ask', pick, image: sent, timeoutMs: AI_TIMEOUT_MS });
        const restMs = Math.max(AI_REST_MIN_MS, Math.min(AI_REST_MAX_MS, (Date.now() - started) * AI_REST_FACTOR));
        await chrome.storage.session.set({ aiRestUntil: Date.now() + restMs });
        if (screen === null) { if (!job.cancelled) aiPickedAt = 0; }
        else if (key) {
          answers[key] = screen;
          const keys = Object.keys(answers);
          if (keys.length > MAX_AI_ANSWERS) delete answers[keys[0]];
          await chrome.storage.local.set({ aiAnswers: { version: AI_VERSION, seen: answers } });
        }
        resolve(screen);
      } catch {
        aiPickedAt = 0;
        resolve(null);
      }
    };
    nextAiJob();
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
  if (sender.id !== chrome.runtime.id || msg.target) return;
  if (msg.type === 'check-build') checkBuild();
  if (msg.type === 'ai-known') {
    aiKnown(msg.key).then(reply, () => reply(null));
    return true;
  }
  if (msg.type === 'ask-ai') {
    askAi(msg, sender.tab?.id).then(reply);
    return true;
  }
  if (msg.type === 'ai-cancel') cancelAi(sender.tab?.id);
  if (msg.type !== 'check-image') return;
  checkImage(msg.url, msg.fullUrl, msg.key).then(reply, () => reply(null));
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
