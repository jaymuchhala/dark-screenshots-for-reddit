const DEFAULTS = { reader: true, readerMode: 'theme', uploader: true, tinted: true };
const reader = document.getElementById('reader');
const uploader = document.getElementById('uploader');
const tinted = document.getElementById('tinted');
const modeBox = document.getElementById('readerMode');
const modes = [...document.querySelectorAll('input[name=readerMode]')];

function show(settings) {
  reader.checked = settings.reader;
  uploader.checked = settings.uploader;
  tinted.checked = settings.tinted;
  modes.forEach((radio) => { radio.checked = radio.value === settings.readerMode; });
  modeBox.classList.toggle('off', !settings.reader);
}

function save() {
  const settings = {
    reader: reader.checked,
    uploader: uploader.checked,
    tinted: tinted.checked,
    readerMode: modes.find((radio) => radio.checked).value,
  };
  chrome.storage.local.set({ settings });
  show(settings);
}

chrome.storage.local.get('settings').then((stored) => {
  show({ ...DEFAULTS, ...stored.settings });
  [reader, uploader, tinted, ...modes].forEach((input) => input.addEventListener('change', save));
});
