// Is this image a capture of software on a screen? MobileNetV4 small, 8 MB, in the package, on one CPU
// thread: about 30ms an image and no GPU, so it can't touch scrolling and nothing has to wait for a quiet
// moment. It's a stock ImageNet model, and one of ImageNet's 1000 classes is "web site".
const WEB_SITE = 916;
const SCREEN_MIN = 0.1;   // 36 of 39 screenshots above this, and 5 of 100 comics, memes, drawings, pages and photos
const INPUT_SIZE = 224;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const UNLOAD_MS = 5 * 60000;

let session = null;
let turn = Promise.resolve();
let unloadTimer = null;

async function loadModel() {
  if (session) return session;
  const base = chrome.runtime.getURL('');
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = base + 'vendor/ort/';
  session = await ort.InferenceSession.create(base + 'model/mobilenetv4-small.onnx', { executionProviders: ['wasm'] });
  return session;
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
  const model = await loadModel();
  const out = await model.run({ [model.inputNames[0]]: inputTensor(pixels) });
  clearTimeout(unloadTimer);
  unloadTimer = setTimeout(() => { session?.release(); session = null; }, UNLOAD_MS);
  return webSiteShare(out[model.outputNames[0]].data) >= SCREEN_MIN;
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || msg.target !== 'offscreen' || msg.type !== 'is-screen') return;
  // null: no answer, so the pixel checks decide.
  turn = turn.then(() => isScreen(msg.pixels)).then(reply, () => reply(null));
  return true;
});
