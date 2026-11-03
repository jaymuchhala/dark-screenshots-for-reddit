// The AI check: "is this image a capture of software on a screen?" Runs on the device,
// through Chrome's built-in model or a local Ollama. Loaded by offscreen.html, since the
// built-in model isn't available in workers, and by the popup, for the status line.

const AI_PROMPT = `Is this image a capture of a computer or phone screen showing software, such as a web page, online store, news site, forum, documentation, app, dashboard, settings, email, chat or code editor?
Say "yes" even if the page has photos, drawings or mostly text on it.
Say "no" if the image itself is a comic, cartoon, drawing, meme, poster, diagram, infographic, chart, map, scanned paper, handwriting, book page or a photo.
Answer with JSON: {"screen": "yes"} or {"screen": "no"}`;

const OLLAMA_URL = 'http://localhost:11434';
const NANO_OPTS = {
  expectedInputs: [{ type: 'image' }, { type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
};
const AI_SCHEMA = { type: 'object', properties: { screen: { enum: ['yes', 'no'] } }, required: ['screen'] };

// unsupported | unavailable | downloadable | downloading | available
async function nanoStatus() {
  if (typeof LanguageModel === 'undefined') return { state: 'unsupported' };
  try {
    return { state: await LanguageModel.availability(NANO_OPTS) };
  } catch {
    return { state: 'unsupported' };
  }
}

// offline | forbidden | no-model | available. Takes the smallest model that can see images.
async function ollamaStatus() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    if (res.status === 403) return { state: 'forbidden' };
    if (!res.ok) return { state: 'offline' };
    const models = (await res.json()).models || [];
    models.sort((a, b) => a.size - b.size);
    for (const { name } of models) {
      const show = await fetch(`${OLLAMA_URL}/api/show`, { method: 'POST', body: JSON.stringify({ model: name }) });
      if (show.ok && (await show.json()).capabilities?.includes('vision')) return { state: 'available', model: name };
    }
    return { state: 'no-model' };
  } catch {
    return { state: 'offline' };
  }
}

// Which engine answers, or null if none is ready, in which case the checks work alone.
// Ollama goes first in auto: it only answers if someone set it up for this.
async function pickEngine(choice) {
  if (choice !== 'chrome') {
    const ollama = await ollamaStatus();
    if (ollama.state === 'available') return { engine: 'ollama', model: ollama.model };
  }
  if (choice !== 'ollama' && (await nanoStatus()).state === 'available') return { engine: 'chrome' };
  return null;
}

let nanoBase = null;
async function askNano(blob, signal) {
  // Creating the session is the slow part, so one stays loaded and each image gets a copy.
  nanoBase ??= LanguageModel.create(NANO_OPTS).catch((e) => { nanoBase = null; throw e; });
  const session = await (await nanoBase).clone();
  signal.addEventListener('abort', () => session.destroy());
  try {
    return await session.prompt(
      [{ role: 'user', content: [{ type: 'text', value: AI_PROMPT }, { type: 'image', value: blob }] }],
      { responseConstraint: AI_SCHEMA, signal },
    );
  } finally {
    session.destroy();
  }
}

async function askOllama(dataUrl, model, signal) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    signal,
    body: JSON.stringify({
      model,
      stream: false,
      format: 'json',
      options: { temperature: 0, num_predict: 20 },
      messages: [{ role: 'user', content: AI_PROMPT, images: [dataUrl.split(',')[1]] }],
    }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  return (await res.json()).message.content;
}

// True if the image is a screen, false if not. Throws if there's no clear answer.
async function askEngine({ engine, model }, dataUrl, signal) {
  const text = engine === 'ollama'
    ? await askOllama(dataUrl, model, signal)
    : await askNano(await (await fetch(dataUrl)).blob(), signal);
  const { screen } = JSON.parse(text);
  if (screen !== 'yes' && screen !== 'no') throw new Error('No clear answer');
  return screen === 'yes';
}
