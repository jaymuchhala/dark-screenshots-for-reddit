// Shared by the background worker (reader) and the content script (uploader).

// Same look in both parts: white becomes about #121212, black about #ededed, and
// the hue rotation keeps colors close to their original hue.
const DARK_FILTER = 'invert(0.93) hue-rotate(180deg)';

const SAMPLE_SIZE = 320;
const PHOTO_MIN_COLORS = 8;
const PHOTO_MIN_GROUP = 0.0015;
const PHOTO_MAX = 0.003;
const FLAT_PAGE_MIN = 0.22;
const FLAT_WHOLE_MIN = 0.45;

// Decides from pixels whether an image is a light-theme screenshot. Screenshots are
// mostly flat, pale areas, white or (with the tinted setting) lightly tinted like a
// cream chart background. Photos have texture everywhere, and already dark images
// aren't pale.
function measure(data, width, height) {
  let light = 0, tinted = 0, flat = 0, colorful = 0, dark = 0;
  const total = width * height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] < 128) continue;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      if (luma >= 215 && chroma <= 24) light++;
      if (luma >= 215 && chroma <= 48) tinted++;
      if (chroma > 48) colorful++;
      if (luma < 70) dark++;
      const right = x + 1 < width ? i + 4 : i;
      const down = y + 1 < height ? i + width * 4 : i;
      const diff = Math.abs(r - data[right]) + Math.abs(g - data[right + 1]) + Math.abs(b - data[right + 2]) +
        Math.abs(r - data[down]) + Math.abs(g - data[down + 1]) + Math.abs(b - data[down + 2]);
      if (diff <= 6) flat++;
    }
  }
  return { light: light / total, tinted: tinted / total, flat: flat / total, colorful: colorful / total, dark: dark / total };
}

function isLightScreenshot({ light, tinted, flat, colorful, photo = 0, flatPage = 1 }, allowTinted) {
  if (photo > PHOTO_MAX || flatPage < FLAT_WHOLE_MIN) return false;
  // Tinted backgrounds often come with charts, which have more color on them.
  return (allowTinted ? tinted : light) >= 0.5 && flat >= 0.55 && colorful <= (allowTinted ? 0.25 : 0.15);
}

// Video previews are tiny (about 170x96), so text blurs and less of a frame is flat.
// A frame's text is mush at that size, so a little of it can pass for photo.
function isLightVideoFrame({ light, flat, colorful, photo = 0, flatPage = 1 }) {
  return light >= 0.55 && flat >= 0.4 && colorful <= 0.15 && photo <= VIDEO_PHOTO_MAX && flatPage >= FLAT_WHOLE_MIN;
}

const VIDEO_PHOTO_MAX = 0.05;
const VIDEO_SAMPLES = 5;
const VIDEO_PART_SAMPLES = 12;
const VIDEO_PART_SHARE = 0.1;
const VIDEO_PART_HITS = 3;
const VIDEO_PART_SIZE = 480;
const VIDEO_TIMEOUT_MS = 15000;
const SCREEN_INPUT_SIZE = 224;

// Page only: the worker has no video element. Samples frames across the whole video,
// because a poster or a single frame can be a white title card on real-life footage.
// Returns how many frames `look(data, w, h)` said yes to.
async function countVideoFrames(url, samples, size, look) {
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.preload = 'auto';
  const reached = (event) => new Promise((resolve, reject) => {
    video.addEventListener(event, resolve, { once: true });
    video.addEventListener('error', reject, { once: true });
  });
  const sample = async () => {
    const ready = reached('loadedmetadata');
    video.src = url;
    await ready;
    if (!Number.isFinite(video.duration) || !video.videoWidth) return 0;
    const scale = Math.min(1, size / Math.max(video.videoWidth, video.videoHeight));
    const w = Math.max(1, Math.round(video.videoWidth * scale));
    const h = Math.max(1, Math.round(video.videoHeight * scale));
    const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
    let hits = 0;
    for (let i = 0; i < samples; i++) {
      const seeked = reached('seeked');
      video.currentTime = video.duration * (i + 0.5) / samples;
      await seeked;
      ctx.drawImage(video, 0, 0, w, h);
      if (look(ctx.getImageData(0, 0, w, h).data, w, h)) hits++;
    }
    return hits;
  };
  let timer;
  try {
    return await Promise.race([
      sample(),
      new Promise((_, reject) => { timer = setTimeout(reject, VIDEO_TIMEOUT_MS); }),
    ]);
  } finally {
    clearTimeout(timer);
    video.removeAttribute('src');
    video.load();
  }
}

const countPartFrames = (url, size) => countVideoFrames(url, VIDEO_PART_SAMPLES, size, (data, w, h) =>
  lightRegions(data, w, h).reduce((total, r) => total + r.w * r.h, 0) >= w * h * VIDEO_PART_SHARE);

// True if the whole video is light UI, 'parts' if it has light UI over other footage,
// false if neither. One frame may differ, for an intro or an outro. The tiny preview only
// rules videos out for the parts check, since panels lose their edges at that size.
async function checkVideo(previewUrl, largerUrl) {
  const hits = await countVideoFrames(previewUrl, VIDEO_SAMPLES, SAMPLE_SIZE, (data, w, h) => isLightVideoFrame({ ...measure(data, w, h), ...photoTraits(data, w, h) }));
  if (hits >= VIDEO_SAMPLES - 1) return true;
  if (!largerUrl || !await countPartFrames(previewUrl, SAMPLE_SIZE)) return false;
  return await countPartFrames(largerUrl, VIDEO_PART_SIZE) >= VIDEO_PART_HITS ? 'parts' : false;
}

// Whether a group of pixels has the many blended colors of a photo. Buttons, charts,
// panels and headlines are mostly one color, however big they are.
function isPhotoLike(data, queue, start, end) {
  const bins = new Map();
  for (let i = start; i < end; i++) {
    const p = queue[i] * 4;
    const bin = (data[p] >> 4) << 8 | (data[p + 1] >> 4) << 4 | data[p + 2] >> 4;
    bins.set(bin, (bins.get(bin) || 0) + 1);
  }
  const counts = [...bins.values()].sort((a, b) => b - a);
  if (counts[0] > (end - start) * 0.5) return false;
  let covered = 0, used = 0;
  while (covered < (end - start) * 0.9) covered += counts[used++];
  return used >= PHOTO_MIN_COLORS;
}

// How much of the image is photo, once text and thin lines are off, and how much is one
// of its three most common pale colors. A UI page is exact colors, while a pale sky or
// wall drifts. A photo inverted is a negative, so neither may go through a plain invert.
function photoTraits(data, width, height) {
  const n = width * height;
  let other = new Uint8Array(n);
  const pale = new Uint32Array(262144);
  for (let i = 0; i < n; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    if (0.299 * r + 0.587 * g + 0.114 * b >= 205 && Math.max(r, g, b) - Math.min(r, g, b) <= 48) pale[(r >> 2) << 12 | (g >> 2) << 6 | b >> 2]++;
    else other[i] = 1;
  }
  other = shrunk(shrunk(other, width), width);
  let photo = 0;
  eachGroup(other, width, new Int32Array(n), (start, end, queue) => {
    if (end - start >= n * PHOTO_MIN_GROUP && isPhotoLike(data, queue, start, end)) photo += end - start;
  });
  const top = [0, 0, 0];
  for (const count of pale) {
    if (count <= top[2]) continue;
    top[2] = count;
    top.sort((a, b) => b - a);
  }
  return { photo: photo / n, flatPage: (top[0] + top[1] + top[2]) / n };
}

async function analyzeBlob(blob) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, SAMPLE_SIZE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const { data } = ctx.getImageData(0, 0, w, h);
  return { ...measure(data, w, h), ...photoTraits(data, w, h), sides: paleSides(data, w, h), around: darkPanelKind(data, w, h) };
}

// Some screenshots are a white page with dark panels and photos on it. Inverting the
// whole image would turn those panels white, so only the page gets darkened. This is
// slower and needs a bigger image, so it only runs on images that come close: mostly
// pale but not flat enough to pass, or passing but with a lot of dark in them.
const PARTIAL_SIZE = 1600;
const PARTIAL_MIN_LIGHT = 0.45;
const PARTIAL_THIN_LINE = 2;

function mayBePartial(stats) {
  if (stats.tinted < PARTIAL_MIN_LIGHT || stats.colorful > 0.45 || stats.flatPage < FLAT_PAGE_MIN) return false;
  return !isLightScreenshot(stats, true) || stats.dark >= 0.06;
}

// With the tinted setting off, a cream page isn't darkened.
function usesPartial(stats, allowTinted, allowFrames) {
  if (!stats?.partial || (stats.framed && !allowFrames)) return false;
  if (stats.panelled) return true;
  return allowTinted || stats.light >= (stats.framed ? FRAME_MIN_LIGHT : PARTIAL_MIN_LIGHT);
}

// A dark image can sit on a pale frame. Only the frame gets darkened, so the image
// doesn't turn white. A side counts if a line near that edge is almost all pale, and a
// crop can cut one side off. A meme's caption bars only reach two sides.
const FRAME_MIN_DARK = 0.5;
const FRAME_MIN_LIGHT = 0.03;
const FRAME_EDGE = 0.03;

function paleSides(data, width, height) {
  const pale = (x, y) => {
    const i = (y * width + x) * 4, r = data[i], g = data[i + 1], b = data[i + 2];
    return 0.299 * r + 0.587 * g + 0.114 * b >= 205 && Math.max(r, g, b) - Math.min(r, g, b) <= 48;
  };
  const side = (depth, length, at) => {
    for (let d = 0; d < depth; d++) {
      let count = 0;
      for (let t = 0; t < length; t++) if (at(d, t)) count++;
      if (count >= length * 0.85) return 1;
    }
    return 0;
  };
  const deepX = Math.ceil(width * FRAME_EDGE), deepY = Math.ceil(height * FRAME_EDGE);
  return side(deepY, width, (d, t) => pale(t, d)) + side(deepY, width, (d, t) => pale(t, height - 1 - d)) +
    side(deepX, height, (d, t) => pale(d, t)) + side(deepX, height, (d, t) => pale(width - 1 - d, t));
}

function mayBeFrame(stats) {
  return stats.sides >= 3 && stats.dark >= FRAME_MIN_DARK && stats.tinted < PARTIAL_MIN_LIGHT && stats.colorful <= 0.25;
}

// Calls found(start, end) for each 4-connected group of pixels with `want` set.
// The group's pixels are queue[start] to queue[end - 1].
function eachGroup(want, width, queue, found) {
  const n = want.length, seen = new Uint8Array(n);
  for (let s = 0; s < n; s++) {
    if (!want[s] || seen[s]) continue;
    let start = 0, end = 1;
    queue[0] = s;
    seen[s] = 1;
    while (start < end) {
      const c = queue[start++], x = c % width;
      if (x + 1 < width && want[c + 1] && !seen[c + 1]) { seen[c + 1] = 1; queue[end++] = c + 1; }
      if (x > 0 && want[c - 1] && !seen[c - 1]) { seen[c - 1] = 1; queue[end++] = c - 1; }
      if (c + width < n && want[c + width] && !seen[c + width]) { seen[c + width] = 1; queue[end++] = c + width; }
      if (c - width >= 0 && want[c - width] && !seen[c - width]) { seen[c - width] = 1; queue[end++] = c - width; }
    }
    found(0, end, queue);
  }
}

// Pale colors that cover enough of the image to be a page background.
function pageColors(data, n) {
  const counts = new Map();
  for (let i = 0; i < n; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    if (0.299 * r + 0.587 * g + 0.114 * b < 205 || Math.max(r, g, b) - Math.min(r, g, b) > 48) continue;
    const key = (r >> 3) << 10 | (g >> 3) << 5 | (b >> 3);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts].filter(([, count]) => count >= n * 0.03)
    .map(([key]) => [(key >> 10) * 8 + 4, ((key >> 5) & 31) * 8 + 4, (key & 31) * 8 + 4]);
}

// A white ceiling in a photo can run into a white page and bite into a group, and a
// panel over a photo joins the two. So a big group is cut into the rectangles it mostly
// fills, which gives photos and panels straight edges.
function groupBoxes(pixels, width, n) {
  const boxes = [];
  for (let round = 0; round < 4 && pixels.length >= n * 0.03; round++) {
    const rows = new Map(), cols = new Map();
    for (const c of pixels) {
      const x = c % width, y = (c - x) / width;
      rows.set(y, (rows.get(y) || 0) + 1);
      cols.set(x, (cols.get(x) || 0) + 1);
    }
    const ys = [...rows.keys()], xs = [...cols.keys()];
    const boxW = Math.max(...xs) - Math.min(...xs) + 1, boxH = Math.max(...ys) - Math.min(...ys) + 1;
    const fullX = xs.filter((x) => cols.get(x) >= boxH * 0.4), fullY = ys.filter((y) => rows.get(y) >= boxW * 0.4);
    if (!fullX.length || !fullY.length) break;
    let x0 = Math.min(...fullX), x1 = Math.max(...fullX), y0 = Math.min(...fullY), y1 = Math.max(...fullY);
    // A panel sticking out past a photo shouldn't drag the box out over the page with it.
    const line = (fromX, fromY, toX, toY) => {
      let on = 0;
      for (let y = fromY; y <= toY; y++) for (let x = fromX; x <= toX; x++) if (set[y * width + x]) on++;
      return on / ((toX - fromX + 1) * (toY - fromY + 1));
    };
    const set = new Uint8Array(n);
    for (const c of pixels) set[c] = 1;
    while (y0 < y1 && line(x0, y0, x1, y0) < 0.5) y0++;
    while (y0 < y1 && line(x0, y1, x1, y1) < 0.5) y1--;
    while (x0 < x1 && line(x0, y0, x0, y1) < 0.5) x0++;
    while (x0 < x1 && line(x1, y0, x1, y1) < 0.5) x1--;
    const inside = (c) => { const x = c % width, y = (c - x) / width; return x >= x0 && x <= x1 && y >= y0 && y <= y1; };
    let count = 0;
    for (const c of pixels) if (inside(c)) count++;
    // Anything less than mostly filled is several things still joined up, not one photo.
    if (count < (x1 - x0 + 1) * (y1 - y0 + 1) * 0.6) break;
    boxes.push([x0, y0, x1, y1]);
    pixels = pixels.filter((c) => !inside(c));
  }
  return boxes;
}

// Returns which pixels to darken and how the split came out, or null if there's no page.
function pageMask(data, width, height) {
  const n = width * height;
  const colors = pageColors(data, n);
  if (!colors.length) return null;
  const pale = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    if (colors.some((c) => Math.abs(r - c[0]) <= 10 && Math.abs(g - c[1]) <= 10 && Math.abs(b - c[2]) <= 10)) pale[i] = 1;
  }
  const queue = new Int32Array(n);
  // A frame around the page can be a gradient, too spread out to count above. Pale
  // pixels joined to the edge of the image are page too.
  const paleAny = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    if (0.299 * r + 0.587 * g + 0.114 * b >= 205 && Math.max(r, g, b) - Math.min(r, g, b) <= 48) paleAny[i] = 1;
  }
  eachGroup(paleAny, width, queue, (start, end) => {
    let touches = false;
    for (let i = start; i < end && !touches; i++) {
      const c = queue[i], x = c % width;
      touches = x === 0 || x === width - 1 || c < width || c >= n - width;
    }
    if (touches) for (let i = start; i < end; i++) pale[queue[i]] = 1;
  });
  // The page is the big pale areas. Small pale spots are part of what's on top of it.
  const other = new Uint8Array(n).fill(1);
  let page = 0;
  eachGroup(pale, width, queue, (start, end) => {
    if (end - start < n * 0.02) return;
    page += end - start;
    for (let i = start; i < end; i++) other[queue[i]] = 0;
  });
  if (!page) return null;
  // Big things on the page stay as they are. Small things, like text, get darkened.
  // Thin lines come off first, since a border or divider can join everything on the
  // page into one big thing.
  let solid = other;
  for (let i = 0; i < PARTIAL_THIN_LINE; i++) solid = shrunk(solid, width);
  let keep = new Uint8Array(n);
  const boxes = [];
  eachGroup(solid, width, queue, (start, end) => {
    if (end - start < n * 0.004) return;
    // Pale and flat, like a map or a card, is more page rather than a picture.
    let sum = 0;
    for (let i = start; i < end; i++) sum += 0.299 * data[queue[i] * 4] + 0.587 * data[queue[i] * 4 + 1] + 0.114 * data[queue[i] * 4 + 2];
    if (sum / (end - start) >= 150 && !isPhotoLike(data, queue, start, end)) return;
    for (let i = start; i < end; i++) keep[queue[i]] = 1;
    if (end - start >= n * 0.03) boxes.push(...groupBoxes(queue.slice(start, end), width, n));
  });
  for (let i = 0; i < PARTIAL_THIN_LINE; i++) keep = grown(keep, width);
  const mask = new Uint8Array(n);
  let share = 0, ink = 0;
  for (let i = 0; i < n; i++) {
    if (other[i] && !keep[i]) ink++;
    mask[i] = other[i] && keep[i] ? 0 : 1;
  }
  for (const [x0, y0, x1, y1] of boxes) {
    for (let y = y0; y <= y1; y++) mask.fill(0, y * width + x0, y * width + x1 + 1);
  }
  for (let i = 0; i < n; i++) share += mask[i];
  // Text and icons on the page are what separate a screenshot from a product on white.
  const small = other.slice(), glyphs = [];
  for (let i = 0; i < n; i++) if (keep[i]) small[i] = 0;
  eachGroup(small, width, queue, (start, end) => {
    let x0 = width, x1 = 0, y0 = height, y1 = 0;
    for (let i = start; i < end; i++) {
      const x = queue[i] % width, y = (queue[i] - x) / width;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    glyphs.push({ x0, x1, h: y1 - y0 + 1, cy: (y0 + y1) / 2 });
  });
  return { mask, share: share / n, ink: ink / page, lines: textLines(glyphs, height) };
}

function isPartialScreenshot({ share, ink, lines }) {
  return share >= 0.4 && (ink >= 0.02 ? lines >= 2 : ink >= 0.005 && lines >= 5);
}

// mayBeFrame already looked at the shape, and a frame may have no text on it.
function isFrameScreenshot({ share }) {
  return share >= 0.03 && share <= 0.5;
}

// Counts lines of text among small things: at least 5 of a similar height in a row, side
// by side. A photo's specks and a hair's strands don't line up like that.
function textLines(boxes, height) {
  const glyphs = boxes.filter((b) => b.h >= 4 && b.h <= height * 0.12).slice(0, 5000);
  glyphs.sort((a, b) => a.cy - b.cy);
  const used = new Uint8Array(glyphs.length);
  let lines = 0;
  for (let i = 0; i < glyphs.length; i++) {
    if (used[i]) continue;
    const { cy, h } = glyphs[i], row = [];
    for (let j = i; j < glyphs.length && glyphs[j].cy - cy <= h * 0.35; j++) {
      if (!used[j] && glyphs[j].h >= h * 0.5 && glyphs[j].h <= h * 2) row.push(j);
    }
    row.sort((a, b) => glyphs[a].x0 - glyphs[b].x0);
    let chain = [], best = [];
    for (const j of row) {
      if (chain.length && glyphs[j].x0 - glyphs[chain[chain.length - 1]].x1 > h * 3) chain = [];
      chain.push(j);
      if (chain.length > best.length) best = chain;
    }
    if (best.length < 5) continue;
    lines++;
    for (const j of best) used[j] = 1;
  }
  return lines;
}

// Takes a pixel off the edge of everything in the mask.
function shrunk(mask, width) {
  const out = mask.slice(), n = mask.length;
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    if ((i % width && !mask[i - 1]) || ((i + 1) % width && !mask[i + 1]) ||
      (i >= width && !mask[i - width]) || (i + width < n && !mask[i + width])) out[i] = 0;
  }
  return out;
}

// Grows the mask by a pixel, because the pixels at an edge are a blend that isn't
// page-colored and would otherwise stay as a bright outline.
function grown(mask, width) {
  const out = mask.slice(), n = mask.length;
  for (let i = 0; i < n; i++) {
    if (mask[i]) continue;
    if ((i % width && mask[i - 1]) || ((i + 1) % width && mask[i + 1]) || mask[i - width] || mask[i + width]) out[i] = 1;
  }
  return out;
}

function maskCanvas(on, w, h) {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const pixels = ctx.createImageData(w, h);
  on.forEach((value, i) => { pixels.data[i * 4 + 3] = value ? 255 : 0; });
  ctx.putImageData(pixels, 0, 0);
  return canvas;
}

// What the model looks at: a squashed 224x224 copy, as base64 RGB, since messages can't carry bytes.
async function screenPixels(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(SCREEN_INPUT_SIZE, SCREEN_INPUT_SIZE);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.imageSmoothingQuality = 'high';
  context.fillStyle = '#fff';
  context.fillRect(0, 0, SCREEN_INPUT_SIZE, SCREEN_INPUT_SIZE);
  context.drawImage(bitmap, 0, 0, SCREEN_INPUT_SIZE, SCREEN_INPUT_SIZE);
  bitmap.close();
  const rgba = context.getImageData(0, 0, SCREEN_INPUT_SIZE, SCREEN_INPUT_SIZE).data;
  const chars = new Array(SCREEN_INPUT_SIZE * SCREEN_INPUT_SIZE * 3);
  for (let i = 0, n = 0; i < rgba.length; i += 4) {
    chars[n++] = String.fromCharCode(rgba[i]);
    chars[n++] = String.fromCharCode(rgba[i + 1]);
    chars[n++] = String.fromCharCode(rgba[i + 2]);
  }
  return btoa(chars.join(''));
}

// A frame from the middle of a video, for the model. Null if the file can't be read.
async function screenVideoFrame(url) {
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.preload = 'auto';
  const reached = (event) => new Promise((resolve, reject) => {
    video.addEventListener(event, resolve, { once: true });
    video.addEventListener('error', reject, { once: true });
  });
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const ready = reached('loadedmetadata');
        video.src = url;
        await ready;
        const seeked = reached('seeked');
        video.currentTime = video.duration / 2;
        await seeked;
        const canvas = new OffscreenCanvas(video.videoWidth, video.videoHeight);
        canvas.getContext('2d').drawImage(video, 0, 0);
        return screenPixels(await canvas.convertToBlob());
      })(),
      new Promise((resolve) => { timer = setTimeout(resolve, VIDEO_TIMEOUT_MS, null); }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    video.removeAttribute('src');
    video.load();
  }
}

function dataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Returns the partly dark picture as a data URL, or null if it isn't that kind of image.
async function partialDarken(blob, accepts = isPartialScreenshot) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, PARTIAL_SIZE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const picture = new OffscreenCanvas(w, h);
  const ctx = picture.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  const found = pageMask(ctx.getImageData(0, 0, w, h).data, w, h);
  if (!found || !accepts(found)) {
    bitmap.close();
    return null;
  }
  const mask = maskCanvas(grown(found.mask, w), w, h);
  const dark = new OffscreenCanvas(w, h);
  const darkCtx = dark.getContext('2d');
  darkCtx.filter = DARK_FILTER;
  darkCtx.drawImage(bitmap, 0, 0, w, h);
  darkCtx.filter = 'blur(0.6px)';
  darkCtx.globalCompositeOperation = 'destination-in';
  darkCtx.drawImage(mask, 0, 0);
  bitmap.close();
  ctx.drawImage(dark, 0, 0);
  const out = await picture.convertToBlob({ type: 'image/webp', quality: 0.9 });
  return dataUrl(out);
}

// A pale photo can be as flat as a page in the small copy: a laptop on a white desk. At
// full size it has something in many tones on it and no line of text anywhere. Only a page
// with little of one color needs this look, which saves most screenshots a fetch.
const mayBePalePhoto = (stats) => stats.flatPage < 0.7 && isLightScreenshot(stats, true);
async function isPalePhoto(blob) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, PARTIAL_SIZE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const { data } = ctx.getImageData(0, 0, w, h);
  const found = pageMask(data, w, h);
  if (!found || found.lines || found.share >= 0.93) return false;
  // A chart has no text either, but its bars and lines are a few flat colors.
  const tones = new Map();
  let rest = 0;
  for (let i = 0; i < w * h; i++) {
    if (found.mask[i]) continue;
    const key = (data[i * 4] >> 4) << 8 | (data[i * 4 + 1] >> 4) << 4 | data[i * 4 + 2] >> 4;
    tones.set(key, (tones.get(key) || 0) + 1);
    rest++;
  }
  const top = [...tones.values()].sort((a, b) => b - a).slice(0, 4).reduce((a, b) => a + b, 0);
  return top < rest * 0.85;
}

// A dark panel shown off on something bright that isn't a page: a blurred screenshot
// behind it, or a photo under a browser's pale toolbar. The panel stays as it is.
const PANEL_GRID = 24;
const PANEL_MIN_AREA = 0.05;
const BAR_MIN = 0.03, BAR_MAX = 0.25, BAR_GAP = 0.04;

const isDarkPixel = (data, i) => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] < 80 &&
  Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) < 70;

// The biggest solid dark rectangle, with exact edges, or null.
function findPanel(data, width, height) {
  const cell = Math.max(2, Math.round(Math.max(width, height) / PANEL_GRID));
  const cols = Math.ceil(width / cell), rows = Math.ceil(height / cell);
  const dark = new Float32Array(cols * rows), count = new Float32Array(cols * rows);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = Math.floor(y / cell) * cols + Math.floor(x / cell);
      count[c]++;
      if (isDarkPixel(data, (y * width + x) * 4)) dark[c]++;
    }
  }
  const want = new Uint8Array(cols * rows);
  for (let c = 0; c < want.length; c++) want[c] = dark[c] / count[c] >= 0.5 ? 1 : 0;
  let best = null;
  eachGroup(want, cols, new Int32Array(cols * rows), (start, end, queue) => {
    let x0 = cols, x1 = 0, y0 = rows, y1 = 0;
    for (let i = start; i < end; i++) {
      const x = queue[i] % cols, y = (queue[i] - x) / cols;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (end - start < w * h * 0.75 || (best && w * h <= best.w * best.h)) return;
    best = { x0, y0, w, h };
  });
  if (!best) return null;
  const share = best.w * best.h * cell * cell / (width * height);
  if (share < PANEL_MIN_AREA || share > 0.85) return null;
  // Exact edges: the first line that's mostly dark, looking around the cell's edge.
  const across = (y, from, to) => { let on = 0; for (let x = from; x < to; x++) if (isDarkPixel(data, (y * width + x) * 4)) on++; return on / (to - from); };
  const down = (x, from, to) => { let on = 0; for (let y = from; y < to; y++) if (isDarkPixel(data, (y * width + x) * 4)) on++; return on / (to - from); };
  const clampX = (x) => Math.max(0, Math.min(width - 1, x)), clampY = (y) => Math.max(0, Math.min(height - 1, y));
  const left = best.x0 * cell, top = best.y0 * cell;
  const right = clampX((best.x0 + best.w) * cell - 1), bottom = clampY((best.y0 + best.h) * cell - 1);
  let y0 = clampY(top - cell), y1 = clampY(bottom + cell), x0 = clampX(left - cell), x1 = clampX(right + cell);
  while (y0 < top + cell && across(y0, left, right + 1) < 0.4) y0++;
  while (y1 > bottom - cell && across(y1, left, right + 1) < 0.4) y1--;
  while (x0 < left + cell && down(x0, top, bottom + 1) < 0.4) x0++;
  while (x1 > right - cell && down(x1, top, bottom + 1) < 0.4) x1--;
  return { x0, y0, x1, y1 };
}

// Rows from the top that are almost all pale, as a share of the height.
function topBar(data, width, height) {
  let y = 0;
  for (; y < height; y++) {
    let pale = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4, r = data[i], g = data[i + 1], b = data[i + 2];
      if (0.299 * r + 0.587 * g + 0.114 * b >= 190 && Math.max(r, g, b) - Math.min(r, g, b) <= 48) pale++;
    }
    if (pale < width * 0.85) break;
  }
  return y / height;
}

// The box holding everything sharp, or null if sharp things are spread over the image.
// On a blurred background that's the panel, and its border makes for an exact edge.
function sharpBox(data, width, height) {
  const luma = (i) => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  const rows = new Uint32Array(height), cols = new Uint32Array(width), sharp = new Uint8Array(width * height);
  const sharpAt = (x, y) => sharp[y * width + x];
  // Shrinking an image makes a soft edge steeper from pixel to pixel.
  const edge = Math.max(24, 15360 / Math.max(width, height));
  for (let y = 0; y + 1 < height; y++) {
    for (let x = 0; x + 1 < width; x++) {
      const i = (y * width + x) * 4, l = luma(i);
      if (Math.abs(l - luma(i + 4)) > edge || Math.abs(l - luma(i + width * 4)) > edge) { rows[y]++; cols[x]++; sharp[y * width + x] = 1; }
    }
  }
  const range = (counts, min) => {
    let from = 0, to = counts.length - 1;
    while (from < to && counts[from] < min) from++;
    while (to > from && counts[to] < min) to--;
    return [from, to];
  };
  const [x0, x1] = range(cols, height * 0.04), [y0, y1] = range(rows, width * 0.04);
  const share = (x1 - x0 + 1) * (y1 - y0 + 1) / (width * height);
  if (share < PANEL_MIN_AREA || share > 0.7) return null;
  // Nothing sharp may be left outside the box.
  let outside = 0;
  for (let y = 0; y < height; y++) if (y < y0 || y > y1) outside += rows[y];
  for (let x = 0; x < width; x++) if (x < x0 || x > x1) outside += cols[x];
  if (outside > width * height * 0.004) return null;
  // A panel is a dark rectangle with a straight outline and mostly flat insides. A sharp
  // person in front of a blurred background is none of those. Small copies blur too much
  // to show an outline, so they only decide whether the full size is worth a look.
  if (Math.max(width, height) >= 600 && !isOutlined(x0, y0, x1, y1, width, height, sharpAt)) return null;
  let sum = 0, count = 0;
  for (let y = y0; y <= y1; y += 2) for (let x = x0; x <= x1; x += 2) { sum += luma((y * width + x) * 4); count++; }
  return sum / count < 110 ? { x0, y0, x1, y1 } : null;
}

// All four sides have a line of edge pixels, and the insides aren't all edges.
function isOutlined(x0, y0, x1, y1, width, height, sharpAt) {
  const near = 3;
  const line = (length, at) => {
    for (let d = 0; d <= near; d++) {
      let hits = 0;
      for (let t = 0; t < length; t++) if (at(t, d)) hits++;
      if (hits >= length * 0.5) return true;
    }
    return false;
  };
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const top = Math.max(0, y0 - 1), bottom = Math.min(height - 1, y1 + 1), left = Math.max(0, x0 - 1), right = Math.min(width - 1, x1 + 1);
  if (!line(w, (t, d) => sharpAt(x0 + t, Math.min(height - 1, top + d))) || !line(w, (t, d) => sharpAt(x0 + t, Math.max(0, bottom - d))) ||
    !line(h, (t, d) => sharpAt(Math.min(width - 1, left + d), y0 + t)) || !line(h, (t, d) => sharpAt(Math.max(0, right - d), y0 + t))) return false;
  let on = 0, count = 0;
  for (let y = y0; y <= y1; y += 2) for (let x = x0; x <= x1; x += 2) { on += sharpAt(x, y); count++; }
  return on / count < 0.5;
}

// The brightness near the top of what's around the box.
function peakAround(data, width, height, box) {
  const lumas = [];
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      if (x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1) continue;
      const i = (y * width + x) * 4;
      lumas.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    }
  }
  lumas.sort((a, b) => a - b);
  return lumas[Math.floor(lumas.length * 0.9)] || 0;
}

// The blurred page around a panel: big connected areas near the brightest gray, with the
// smudges of text on them taken in. White furniture in a photo is too small to count.
function blurredPage(data, width, height, box, peak) {
  const n = width * height, on = new Uint8Array(n), queue = new Int32Array(n), page = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    if (0.299 * r + 0.587 * g + 0.114 * b >= peak * 0.72 && Math.max(r, g, b) - Math.min(r, g, b) <= 40) on[i] = 1;
  }
  let total = 0;
  eachGroup(on, width, queue, (start, end) => {
    if (end - start < n * 0.02) return;
    total += end - start;
    for (let i = start; i < end; i++) page[queue[i]] = 1;
  });
  const boxArea = (box.x1 - box.x0 + 1) * (box.y1 - box.y0 + 1);
  if (total < (n - boxArea) * 0.15) return null;
  let mask = page;
  const reach = Math.max(1, Math.round(Math.max(width, height) / 100));
  for (let i = 0; i < reach; i++) mask = grown(mask, width);
  const rest = new Uint8Array(n);
  for (let i = 0; i < n; i++) rest[i] = mask[i] ? 0 : 1;
  eachGroup(rest, width, queue, (start, end) => {
    if (end - start < n * 0.03) for (let i = start; i < end; i++) mask[queue[i]] = 1;
  });
  return mask;
}

function darkPanelKind(data, width, height) {
  const panel = findPanel(data, width, height);
  const bar = topBar(data, width, height);
  // A panel floats. A dark photo under a meme's caption runs to the edges of the image.
  const floats = panel && panel.x0 > width * 0.01 && panel.x1 < width * 0.99 && panel.y1 < height * 0.99;
  // An extension's popup hangs right off the toolbar.
  if (floats && bar >= BAR_MIN && bar <= BAR_MAX && panel.y0 >= height * bar - 2 && panel.y0 <= height * (bar + BAR_GAP)) return 'bar';
  const box = sharpBox(data, width, height);
  if (!box) return null;
  // Already dark, or white and so a plain background rather than a washed-out blur.
  const peak = peakAround(data, width, height, box);
  return peak >= 90 && peak < 215 ? 'blur' : null;
}

// Returns the picture with its surroundings dark as a data URL, or null.
async function darkenAroundPanel(blob, kind) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, PARTIAL_SIZE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const picture = new OffscreenCanvas(w, h);
  const ctx = picture.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  const dark = new OffscreenCanvas(w, h);
  const darkCtx = dark.getContext('2d');
  if (darkPanelKind(data, w, h) !== kind) { bitmap.close(); return null; }
  if (kind === 'bar') {
    // A few rows more for the toolbar's soft bottom edge.
    const bar = Math.round(topBar(data, w, h) * h) + 3;
    darkCtx.filter = DARK_FILTER;
    darkCtx.drawImage(bitmap, 0, 0, w, h);
    darkCtx.filter = 'none';
    darkCtx.clearRect(0, bar, w, h - bar);
  } else {
    const box = sharpBox(data, w, h);
    // The blur is a washed-out page, mid-gray where it was white, and inverting mid-gray
    // leaves it mid-gray. Bringing its brightest back up to white first makes it go dark.
    // Blurred photos would turn into bright negatives, so each pixel gets whichever is
    // darker, itself or its dark version. Nothing gets brighter and no edges show.
    const peak = peakAround(data, w, h, box);
    const page = blurredPage(data, w, h, box, peak);
    if (!page) { bitmap.close(); return null; }
    const stretch = Math.min(3, 255 / (peak * 0.9));
    darkCtx.drawImage(bitmap, 0, 0, w, h);
    darkCtx.globalCompositeOperation = 'darken';
    darkCtx.filter = `brightness(${stretch.toFixed(2)}) ${DARK_FILTER}`;
    darkCtx.drawImage(bitmap, 0, 0, w, h);
    // Only the page goes dark. Photos on it stay, and a soft edge matches the blur.
    darkCtx.filter = `blur(${Math.max(1, Math.round(Math.max(w, h) / 270))}px)`;
    darkCtx.globalCompositeOperation = 'destination-in';
    darkCtx.drawImage(maskCanvas(page, w, h), 0, 0);
    darkCtx.filter = 'none';
    darkCtx.globalCompositeOperation = 'destination-out';
    darkCtx.beginPath();
    darkCtx.roundRect(box.x0, box.y0, box.x1 - box.x0 + 1, box.y1 - box.y0 + 1, Math.min(w, h) * 0.035);
    darkCtx.fill();
  }
  bitmap.close();
  ctx.drawImage(dark, 0, 0);
  return dataUrl(await picture.convertToBlob({ type: 'image/webp', quality: 0.9 }));
}

// A video can show light UI, like a browser window or an extension's popup, over
// footage. Inverting the whole video would turn the footage into a negative, so only
// those parts get darkened. They're rectangles with straight edges and text or icons
// on them, which pale areas in footage rarely are.
const REGION_MIN_AREA = 0.012;
const REGION_MIN_WIDTH = 0.1;
const REGION_MIN_HEIGHT = 0.035;
const REGION_HOLE = 0.025;

// Returns [{ x, y, w, h, holes: [{ x, y, w, h }] }] in pixels of the frame. Holes are big
// things on the UI, like a video on a light page or a dark label, that stay as they are.
function lightRegions(data, width, height) {
  const n = width * height;
  const pale = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    if (0.299 * r + 0.587 * g + 0.114 * b >= 205 && Math.max(r, g, b) - Math.min(r, g, b) <= 48) pale[i] = 1;
  }
  const line = width + 1, sum = new Int32Array(line * (height + 1));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      sum[(y + 1) * line + x + 1] = pale[y * width + x] + sum[y * line + x + 1] + sum[(y + 1) * line + x] - sum[y * line + x];
    }
  }
  const paleIn = (x0, y0, x1, y1) => sum[(y1 + 1) * line + x1 + 1] - sum[y0 * line + x1 + 1] - sum[(y1 + 1) * line + x0] + sum[y0 * line + x0];
  const lefts = regionSides(pale, width, height, -1), rights = regionSides(pale, width, height, 1);
  const found = [];
  for (const l of lefts) {
    for (const r of rights) {
      const w = r.x - l.x + 1;
      if (w < width * REGION_MIN_WIDTH) continue;
      const top = Math.max(l.top, r.top), bottom = Math.min(l.bottom, r.bottom);
      if (bottom - top + 1 < height * REGION_MIN_HEIGHT) continue;
      // Rows that are mostly pale. Rows of text or a selected row can dip below that.
      let y0 = -1, y1 = -1, best = 0;
      for (let y = top, start = -1, last = -1; y <= bottom; y++) {
        if (paleIn(l.x, y, r.x, y) < w * 0.5) continue;
        if (start < 0 || y - last > height * 0.04) start = y;
        last = y;
        if (last - start > best) { best = last - start; y0 = start; y1 = last; }
      }
      if (y0 >= 0 && (y1 - y0 + 1) >= height * REGION_MIN_HEIGHT && w * (y1 - y0 + 1) >= n * REGION_MIN_AREA) found.push({ x: l.x, y: y0, w, h: y1 - y0 + 1 });
    }
  }
  found.sort((p, q) => q.w * q.h - p.w * p.h);
  const regions = [];
  for (const box of found) {
    const grown = growRegion(box, width, height, paleIn);
    if (regions.some((r) => overlap(r, grown) > grown.w * grown.h * 0.6)) continue;
    if (finishRegion(grown, data, pale, width, height)) regions.push(grown);
    if (regions.length === 6) break;
  }
  // Merging goes last, with a fresh look at what came of it.
  return mergeRegions(regions, width, height).filter((box) => finishRegion(box, data, pale, width, height)).map((box) => softenEdges(box, data, width, height));
}

// Scaling blurs an edge into a row or two that aren't pale, yet look white once what's next
// to them is dark. The filter darkens anything over mid-gray, so the box takes those in too.
function softenEdges(box, data, width, height) {
  const lit = (x0, y0, x1, y1) => {
    if (x0 < 0 || y0 < 0 || x1 >= width || y1 >= height) return false;
    let count = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = (y * width + x) * 4;
        if (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] >= 128) count++;
      }
    }
    return count >= (x1 - x0 + 1) * (y1 - y0 + 1) * 0.5;
  };
  let x0 = box.x, y0 = box.y, x1 = box.x + box.w - 1, y1 = box.y + box.h - 1;
  for (let i = 0; i < 3 && lit(x0, y0 - 1, x1, y0 - 1); i++) y0--;
  for (let i = 0; i < 3 && lit(x0, y1 + 1, x1, y1 + 1); i++) y1++;
  for (let i = 0; i < 3 && lit(x0 - 1, y0, x0 - 1, y1); i++) x0--;
  for (let i = 0; i < 3 && lit(x1 + 1, y0, x1 + 1, y1); i++) x1++;
  return { ...box, x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// A dark row, like the selected one in a list, can cut a panel in two.
function mergeRegions(regions, width, height) {
  const near = Math.max(2, Math.round(width * 0.008)), gap = height * 0.12;
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < regions.length && !merged; i++) {
      for (let j = i + 1; j < regions.length && !merged; j++) {
        const a = regions[i], b = regions[j];
        if (Math.abs(a.x - b.x) > near || Math.abs(a.x + a.w - b.x - b.w) > near) continue;
        const top = Math.min(a.y, b.y), bottom = Math.max(a.y + a.h, b.y + b.h);
        if (bottom - top > a.h + b.h + gap) continue;
        const x = Math.min(a.x, b.x);
        regions[i] = { x, y: top, w: Math.max(a.x + a.w, b.x + b.w) - x, h: bottom - top };
        regions.splice(j, 1);
        merged = true;
      }
    }
  }
  return regions;
}

const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

// Long straight lines where pale pixels stop, which panels have and pale areas in footage
// rarely do. `side` is -1 for left sides and 1 for right sides. The edge of the frame
// counts as a place to stop. Something pale touching a panel only leaves a gap in the line.
function regionSides(pale, width, height, side) {
  const OUT = 2, minRows = Math.ceil(height * REGION_MIN_HEIGHT), maxGap = Math.round(height * 0.1);
  const sides = [];
  for (let x = 0; x < width; x++) {
    let top = -1, last = -1, on = 0;
    const finish = () => {
      if (top >= 0 && on >= minRows && on >= (last - top + 1) * 0.6) sides.push({ x, top, bottom: last, on });
      top = -1;
      on = 0;
    };
    for (let y = 0; y < height; y++) {
      const out = x + side * OUT;
      const stops = pale[y * width + x] && (out < 0 || out >= width || !pale[y * width + out]);
      if (!stops) continue;
      if (top >= 0 && y - last > maxGap) finish();
      if (top < 0) top = y;
      last = y;
      on++;
    }
    finish();
  }
  // Neighboring columns see the same line, blurred. The longest stands for them.
  sides.sort((a, b) => b.on - a.on);
  const kept = [];
  for (const candidate of sides) {
    if (!kept.some((k) => Math.abs(k.x - candidate.x) <= 3 && k.top <= candidate.bottom && candidate.top <= k.bottom)) kept.push(candidate);
    if (kept.length === 12) break;
  }
  return kept;
}

// Corners are rounded and rows at the ends can be thin, so the box grows while the next
// line out is still mostly pale.
function growRegion({ x, y, w, h }, width, height, paleIn) {
  const fits = (x0, y0, x1, y1) => x0 >= 0 && y0 >= 0 && x1 < width && y1 < height && paleIn(x0, y0, x1, y1) >= (x1 - x0 + 1) * (y1 - y0 + 1) * 0.5;
  let x0 = x, y0 = y, x1 = x + w - 1, y1 = y + h - 1, moved = true;
  while (moved) {
    moved = false;
    if (fits(x0 - 1, y0, x0 - 1, y1)) { x0--; moved = true; }
    if (fits(x1 + 1, y0, x1 + 1, y1)) { x1++; moved = true; }
    if (fits(x0, y0 - 1, x1, y0 - 1)) { y0--; moved = true; }
    if (fits(x0, y1 + 1, x1, y1 + 1)) { y1++; moved = true; }
  }
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// Finds a region's holes, then returns whether it looks like UI: mostly pale and flat,
// with some text or icons on it.
function finishRegion(box, data, pale, width, height) {
  const { x, y, w, h } = box, area = w * h;
  let other = new Uint8Array(area);
  for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) other[v * w + u] = pale[(y + v) * width + x + u] ? 0 : 1;
  const ink = other.slice();
  for (let i = 0; i < 2; i++) other = shrunk(other, w);
  const holes = [];
  const queue = new Int32Array(area);
  eachGroup(other, w, queue, (start, end) => {
    if (end - start < area * REGION_HOLE) return;
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    for (let i = start; i < end; i++) {
      const u = queue[i] % w, v = (queue[i] - u) / w;
      if (u < x0) x0 = u;
      if (u > x1) x1 = u;
      if (v < y0) y0 = v;
      if (v > y1) y1 = v;
    }
    // Takes back what shrinking took off.
    x0 = Math.max(0, x0 - 2); y0 = Math.max(0, y0 - 2); x1 = Math.min(w - 1, x1 + 2); y1 = Math.min(h - 1, y1 + 2);
    if (end - start < (x1 - x0 + 1) * (y1 - y0 + 1) * 0.6) return;
    holes.push({ x: x + x0, y: y + y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
    for (let v = y0; v <= y1; v++) ink.fill(2, v * w + x0, v * w + x1 + 1);
  });
  let open = 0;
  for (let i = 0; i < area; i++) if (ink[i] !== 2) open++;
  if (open < area * 0.25) return false;
  let marks = 0, palePixels = 0, flat = 0;
  const colors = new Map();
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) {
      if (ink[v * w + u] === 2) continue;
      if (ink[v * w + u]) marks++;
      const c = (y + v) * width + x + u;
      if (!pale[c]) continue;
      palePixels++;
      const i = c * 4, color = (data[i] >> 2) << 12 | (data[i + 1] >> 2) << 6 | (data[i + 2] >> 2);
      colors.set(color, (colors.get(color) || 0) + 1);
      const right = u + 1 < w ? i + 4 : i, down = v + 1 < h ? i + width * 4 : i;
      if (Math.abs(data[i] - data[right]) + Math.abs(data[i + 1] - data[right + 1]) + Math.abs(data[i + 2] - data[right + 2]) +
        Math.abs(data[i] - data[down]) + Math.abs(data[i + 1] - data[down + 1]) + Math.abs(data[i + 2] - data[down + 2]) <= 6) flat++;
    }
  }
  box.holes = holes;
  box.fill = palePixels / open;
  box.flat = flat / palePixels;
  box.ink = marks / open;
  // UI is a color or two. Pale ground in footage spreads over many, and a pale sky with
  // things in front of it is only a bit tidier than that.
  box.colors = [...colors.values()].sort((p, q) => q - p).slice(0, 2).reduce((total, count) => total + count, 0) / palePixels;
  return box.fill >= 0.6 && box.flat >= 0.5 && box.ink >= 0.01 && box.colors >= 0.27 && (box.colors >= 0.4 || box.ink < 0.15);
}

// Finds light UI pixel by pixel, for a video that's playing: while a window zooms or slides,
// its edges blur and pairing them up gives pieces with footage in them. Returns rectangles
// in pixels of the frame, one row band at a time. A dark label or a big picture on the UI
// stays out of them.
const LIGHT_HOLE = 0.03;
function lightMask(data, width, height) {
  const n = width * height;
  const pale = new Uint8Array(n), rest = new Uint8Array(n), queue = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    if (0.299 * r + 0.587 * g + 0.114 * b >= 205 && Math.max(r, g, b) - Math.min(r, g, b) <= 48) pale[i] = 1;
    else rest[i] = 1;
  }
  // Text and controls on the UI are small things with pale all around.
  const filled = pale.slice();
  eachGroup(rest, width, queue, (start, end) => {
    if (end - start < n * LIGHT_HOLE) for (let i = start; i < end; i++) filled[queue[i]] = 1;
  });
  // Shrinking and growing back cuts thin links to pale bits in the footage.
  let solid = filled;
  for (let i = 0; i < 2; i++) solid = shrunk(solid, width);
  for (let i = 0; i < 2; i++) solid = grown(solid, width);
  for (let i = 0; i < n; i++) if (!filled[i]) solid[i] = 0;
  cutAtEdges(solid, width, height, queue);
  const keep = new Uint8Array(n);
  eachGroup(solid, width, queue, (start, end) => {
    if (end - start < n * REGION_MIN_AREA) return;
    if (looksLikeUi(queue, start, end, data, pale, width, height)) for (let i = start; i < end; i++) keep[queue[i]] = 1;
  });
  softenMask(keep, data, width);
  return maskRects(keep, width, height);
}

// UI has straight sides, is mostly pale and flat, a color or two, with text or icons on it.
function looksLikeUi(queue, start, end, data, pale, width, height) {
  const { lefts, rights, tops, bottoms } = groupEnds(queue, start, end, width, height);
  let palePixels = 0, flat = 0;
  const colors = new Map();
  for (let q = start; q < end; q++) {
    const c = queue[q], x = c % width, y = (c - x) / width;
    if (!pale[c]) continue;
    palePixels++;
    const i = c * 4, color = (data[i] >> 2) << 12 | (data[i + 1] >> 2) << 6 | (data[i + 2] >> 2);
    colors.set(color, (colors.get(color) || 0) + 1);
    const right = x + 1 < width ? i + 4 : i, down = y + 1 < height ? i + width * 4 : i;
    if (Math.abs(data[i] - data[right]) + Math.abs(data[i + 1] - data[right + 1]) + Math.abs(data[i + 2] - data[right + 2]) +
      Math.abs(data[i] - data[down]) + Math.abs(data[i + 1] - data[down + 1]) + Math.abs(data[i + 2] - data[down + 2]) <= 6) flat++;
  }
  const area = end - start, ink = 1 - palePixels / area;
  if (palePixels / area < 0.6 || flat / palePixels < 0.45) return false;
  const top = [...colors.values()].sort((p, q) => q - p).slice(0, 2).reduce((total, count) => total + count, 0) / palePixels;
  const sides = [straightShare(lefts, width), straightShare(rights, width), straightShare(tops, height), straightShare(bottoms, height)];
  if (sides.some((share) => share < 0.7)) return false;
  const box = sides.every((share) => share >= 0.95);
  // A stretch of bar with nothing on it, cut off from the rest by a panel's edge.
  if (ink < 0.01) return box && flat / palePixels >= 0.9 && top >= 0.8;
  // Motion blur spreads the colors of a bar, but its outline stays a clean box.
  if (box && top >= 0.15) return true;
  return top >= 0.2 && (top >= 0.25 || ink < 0.15);
}

// Where each row and column of a group starts and ends.
function groupEnds(queue, start, end, width, height) {
  const lefts = new Int32Array(height).fill(-1), rights = new Int32Array(height).fill(-1);
  const tops = new Int32Array(width).fill(-1), bottoms = new Int32Array(width).fill(-1);
  for (let q = start; q < end; q++) {
    const x = queue[q] % width, y = (queue[q] - x) / width;
    if (lefts[y] < 0 || x < lefts[y]) lefts[y] = x;
    if (x > rights[y]) rights[y] = x;
    if (tops[x] < 0 || y < tops[x]) tops[x] = y;
    if (y > bottoms[x]) bottoms[x] = y;
  }
  return { lefts, rights, tops, bottoms };
}

// A window can touch something pale in the footage, like a white awning. Its other sides
// still show where its edges run, so the shape is cut along them, and each piece gets looked
// at by itself. softenMask closes the cuts between pieces that turn out to be UI.
function cutAtEdges(solid, width, height, queue) {
  const cuts = [];
  eachGroup(solid, width, queue, (start, end) => {
    if (end - start < solid.length * REGION_MIN_AREA) return;
    const { lefts, rights, tops, bottoms } = groupEnds(queue, start, end, width, height);
    const lines = (ends, size, step) => {
      const counts = new Int32Array(size);
      let used = 0;
      for (const at of ends) if (at >= 0) { counts[at]++; used++; }
      for (let at = 0; at < size; at++) {
        if (counts[at] + (counts[at + 1] || 0) < Math.max(12, used * 0.1) || counts[at] < (counts[at - 1] || 0)) continue;
        cuts.push({ at: at + step, vertical: ends === lefts || ends === rights, used: ends });
      }
    };
    lines(lefts, width, -1);
    lines(rights, width, 1);
    lines(tops, height, -1);
    lines(bottoms, height, 1);
  });
  for (const { at, vertical, used } of cuts) {
    used.forEach((end, i) => {
      if (end < 0) return;
      const c = vertical ? i * width + at : at * width + i;
      if (at >= 0 && at < (vertical ? width : height)) solid[c] = 0;
    });
  }
}

// How many rows end at one of two columns, give or take 2: a window and a popup on it.
function straightShare(ends, width) {
  const counts = new Int32Array(width + 5);
  let rows = 0;
  for (const x of ends) if (x >= 0) { counts[x + 2]++; rows++; }
  let share = 0;
  for (let round = 0; round < 2; round++) {
    let best = 0, at = 0;
    for (let x = 0; x < width; x++) {
      const around = counts[x] + counts[x + 1] + counts[x + 2] + counts[x + 3] + counts[x + 4];
      if (around > best) { best = around; at = x; }
    }
    share += best;
    counts.fill(0, at, at + 5);
  }
  return share / rows;
}

// Scaling blurs an edge into pixels that aren't pale, yet look white once what's next to
// them is dark. The filter darkens anything over mid-gray, so the mask takes those in too.
function softenMask(mask, data, width) {
  const n = mask.length;
  for (let step = 0; step < 3; step++) {
    const before = mask.slice();
    for (let i = 0; i < n; i++) {
      if (before[i]) continue;
      const near = (i % width && before[i - 1]) || ((i + 1) % width && before[i + 1]) || (i >= width && before[i - width]) || (i + width < n && before[i + width]);
      if (near && 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2] >= 128) mask[i] = 1;
    }
  }
}

// Runs of pixels on each row, with the same runs on the next rows joined into one rectangle.
function maskRects(mask, width, height) {
  const rects = [];
  let open = new Map();
  for (let y = 0; y < height; y++) {
    const next = new Map();
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      const from = x;
      while (x + 1 < width && mask[y * width + x + 1]) x++;
      const key = from * 65536 + x, rect = open.get(key);
      if (rect) rect.h++;
      else rects.push(next.set(key, { x: from, y, w: x - from + 1, h: 1 }).get(key));
      if (rect) next.set(key, rect);
    }
    open = next;
  }
  return rects;
}

async function darkenBlob(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.filter = DARK_FILTER;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  // Flat dark UI shows JPEG artifacts badly, so JPEG and WebP stay at high quality.
  const type = ['image/jpeg', 'image/webp'].includes(blob.type) ? blob.type : 'image/png';
  return canvas.convertToBlob({ type, quality: 0.95 });
}
