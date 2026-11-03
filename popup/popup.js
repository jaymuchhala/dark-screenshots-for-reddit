const DEFAULTS = { reader: true, readerMode: 'theme', videos: false, frames: true, uploader: true, tinted: true, aiEngine: 'auto' };
const reader = document.getElementById('reader');
const videos = document.getElementById('videos');
const frames = document.getElementById('frames');
const uploader = document.getElementById('uploader');
const tinted = document.getElementById('tinted');
const modeBox = document.getElementById('readerMode');
const modes = [...document.querySelectorAll('input[name=readerMode]')];
const aiEngine = document.getElementById('aiEngine');
const aiStatus = document.getElementById('aiStatus');
const aiFix = document.getElementById('aiFix');
const aiCommand = document.getElementById('aiCommand');
const aiButton = document.getElementById('aiButton');
const START_OLLAMA = 'OLLAMA_ORIGINS=chrome-extension://* ollama serve';
const PULL_MODEL = 'ollama pull gemma3:4b';

// What the AI check is doing, and the one thing that would get it going.
async function showAi() {
  const choice = aiEngine.value;
  const say = (text, command) => {
    aiStatus.textContent = text;
    aiFix.hidden = !command;
    if (!command) return;
    aiCommand.textContent = command === 'download' ? '' : command;
    aiCommand.hidden = command === 'download';
    aiButton.textContent = command === 'download' ? 'Download model' : 'Copy';
  };
  if (choice === 'off') return say('Only the built-in checks decide what gets darkened.');
  const pick = await pickEngine(choice);
  if (aiEngine.value !== choice) return;
  const keeps = 'Comics, posters and other non-screens stay as they are.';
  if (pick?.engine === 'ollama') return say(`Ollama is ready (${pick.model}). ${keeps}`);
  if (pick?.engine === 'chrome') return say(`Chrome's built-in AI is ready. ${keeps}`);
  const nano = choice === 'ollama' ? null : await nanoStatus();
  if (nano?.state === 'downloading') return say("Chrome is downloading its AI model. Until then, the built-in checks decide.");
  if (nano?.state === 'downloadable') return say("Chrome's AI model isn't on this device yet. Until then, the built-in checks decide.", 'download');
  if (choice === 'chrome') return say("Chrome's built-in AI can't read images on this device. The built-in checks decide.");
  const ollama = await ollamaStatus();
  if (ollama.state === 'no-model') return say('Ollama needs a model that reads images. Until then, the built-in checks decide:', PULL_MODEL);
  say('No AI is running, so the built-in checks decide. To use Ollama, start it with:', START_OLLAMA);
}

aiButton.addEventListener('click', async () => {
  if (!aiCommand.hidden) {
    await navigator.clipboard.writeText(aiCommand.textContent);
    aiButton.textContent = 'Copied';
    return;
  }
  aiButton.disabled = true;
  try {
    const session = await LanguageModel.create({
      ...NANO_OPTS,
      monitor: (m) => m.addEventListener('downloadprogress', (e) => {
        aiStatus.textContent = `Downloading Chrome's AI model: ${Math.round(e.loaded * 100)}%`;
      }),
    });
    session.destroy();
  } catch {}
  aiButton.disabled = false;
  showAi();
});

function show(settings) {
  reader.checked = settings.reader;
  videos.checked = settings.videos;
  frames.checked = settings.frames;
  uploader.checked = settings.uploader;
  tinted.checked = settings.tinted;
  aiEngine.value = settings.aiEngine;
  modes.forEach((radio) => { radio.checked = radio.value === settings.readerMode; });
  modeBox.classList.toggle('off', !settings.reader);
}

function save() {
  const settings = {
    reader: reader.checked,
    videos: videos.checked,
    frames: frames.checked,
    uploader: uploader.checked,
    tinted: tinted.checked,
    aiEngine: aiEngine.value,
    readerMode: modes.find((radio) => radio.checked).value,
  };
  chrome.storage.local.set({ settings });
  show(settings);
}

chrome.storage.local.get('settings').then((stored) => {
  show({ ...DEFAULTS, ...stored.settings });
  [reader, videos, frames, uploader, tinted, ...modes].forEach((input) => input.addEventListener('change', save));
  aiEngine.addEventListener('change', () => {
    // A different engine gets to look at everything again.
    chrome.storage.local.remove('aiAnswers');
    save();
    showAi();
  });
  showAi();
});
