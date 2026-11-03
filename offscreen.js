// Is this image a capture of software on a screen? MobileNetV4 small, 8 MB, in the package, on one CPU
// thread: about 30ms an image and no GPU, so it can't touch scrolling and nothing has to wait for a quiet
// moment. It's a stock ImageNet model, and one of ImageNet's 1000 classes is "web site".
const WEB_SITE = 916;
const SCREEN_MIN = 0.1;   // 36 of 39 screenshots above this, and 5 of 100 comics, memes, drawings, pages and photos
const INPUT_SIZE = 224;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const UNLOAD_MS = 5 * 60000;

// MediaPipe's selfie segmenter, 250 KB: which pixels of a crop of a video are a person.
const PEOPLE_INPUT = 256;
const PEOPLE_MASK = 128;

const models = {
  screen: { file: 'model/mobilenetv4-small.onnx', session: null, timer: null },
  people: { file: 'model/selfie-segmentation.onnx', session: null, timer: null },
};
let turn = Promise.resolve();

async function loadModel(model) {
  clearTimeout(model.timer);
  model.timer = setTimeout(() => { model.session?.release(); model.session = null; }, UNLOAD_MS);
  if (model.session) return model.session;
  const base = chrome.runtime.getURL('');
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = base + 'vendor/ort/';
  model.session = await ort.InferenceSession.create(base + model.file, { executionProviders: ['wasm'] });
  return model.session;
}

function inputTensor(pixels) {
  const rgb = atob(pixels);
  const count = INPUT_SIZE * INPUT_SIZE;
  const data = new Float32Array(count * 3);
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < count; i++) data[c * count + i] = (rgb.charCodeAt(i * 3 + c) / 255 - MEAN[c]) / STD[c];
  }
  return new ort.Tensor('float32', data, [1, 3, INPUT_SIZE, INPUT_SIZE]);
}

function webSiteShare(scores) {
  const top = Math.max(...scores);
  let sum = 0;
  for (const s of scores) sum += Math.exp(s - top);
  return Math.exp(scores[WEB_SITE] - top) / sum;
}

async function isScreen(pixels) {
  const model = await loadModel(models.screen);
  const out = await model.run({ [model.inputNames[0]]: inputTensor(pixels) });
  return webSiteShare(out[model.outputNames[0]].data) >= SCREEN_MIN;
}

// The mask comes back at half the size, base64, one byte a pixel.
async function findPeopleMask(pixels) {
  const model = await loadModel(models.people);
  const rgb = atob(pixels), count = PEOPLE_INPUT * PEOPLE_INPUT;
  const data = new Float32Array(count * 3);
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < count; i++) data[c * count + i] = rgb.charCodeAt(i * 3 + c) / 255;
  }
  const out = await model.run({ [model.inputNames[0]]: new ort.Tensor('float32', data, [1, 3, PEOPLE_INPUT, PEOPLE_INPUT]) });
  const mask = out[model.outputNames[0]].data;
  const chars = new Array(PEOPLE_MASK * PEOPLE_MASK);
  for (let y = 0; y < PEOPLE_MASK; y++) {
    for (let x = 0; x < PEOPLE_MASK; x++) {
      const at = y * 2 * PEOPLE_INPUT + x * 2;
      const value = (mask[at] + mask[at + 1] + mask[at + PEOPLE_INPUT] + mask[at + PEOPLE_INPUT + 1]) / 4;
      chars[y * PEOPLE_MASK + x] = String.fromCharCode(Math.round(value * 255));
    }
  }
  return btoa(chars.join(''));
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || msg.target !== 'offscreen') return;
  const job = msg.type === 'is-screen' ? isScreen : msg.type === 'people' ? findPeopleMask : null;
  if (!job) return;
  // null: no answer, so the pixel checks decide, and a video's people stay as they are.
  turn = turn.then(() => job(msg.pixels)).then(reply, () => reply(null));
  return true;
});
