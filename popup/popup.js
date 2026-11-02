const DEFAULTS = { reader: true, readerMode: 'theme', uploader: true };
const reader = document.getElementById('reader');
const uploader = document.getElementById('uploader');
const modeBox = document.getElementById('readerMode');
const modes = [...document.querySelectorAll('input[name=readerMode]')];

function show(settings) {
  reader.checked = settings.reader;
  uploader.checked = settings.uploader;
  modes.forEach((radio) => { radio.checked = radio.value === settings.readerMode; });
  modeBox.classList.toggle('off', !settings.reader);
}

function save() {
  const settings = {
    reader: reader.checked,
    uploader: uploader.checked,
    readerMode: modes.find((radio) => radio.checked).value,
  };
  chrome.storage.local.set({ settings });
  show(settings);
}

chrome.storage.local.get('settings').then((stored) => {
  show({ ...DEFAULTS, ...stored.settings });
  [reader, uploader, ...modes].forEach((input) => input.addEventListener('change', save));
});
