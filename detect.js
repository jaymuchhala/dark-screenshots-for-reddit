// Shared by the background worker (reader) and the content script (uploader).

// Same look in both parts: white becomes about #121212, black about #ededed, and
// the hue rotation keeps colors close to their original hue.
const DARK_FILTER = 'invert(0.93) hue-rotate(180deg)';

const SAMPLE_SIZE = 320;

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

function isLightScreenshot({ light, tinted, flat, colorful }, allowTinted) {
  // Tinted backgrounds often come with charts, which have more color on them.
  return (allowTinted ? tinted : light) >= 0.5 && flat >= 0.55 && colorful <= (allowTinted ? 0.25 : 0.15);
}

// Video previews are tiny (about 170x96), so text blurs and less of a frame is flat.
function isLightVideoFrame({ light, flat, colorful }) {
  return light >= 0.55 && flat >= 0.4 && colorful <= 0.15;
}

const VIDEO_SAMPLES = 5;
const VIDEO_TIMEOUT_MS = 15000;

// Page only: the worker has no video element. Samples frames across the whole video,
// because a poster or a single frame can be a white title card on real-life footage.
// One frame may differ, for an intro or an outro.
async function isLightVideo(url) {
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
    if (!Number.isFinite(video.duration) || !video.videoWidth) return false;
    const scale = Math.min(1, SAMPLE_SIZE / Math.max(video.videoWidth, video.videoHeight));
    const w = Math.max(1, Math.round(video.videoWidth * scale));
    const h = Math.max(1, Math.round(video.videoHeight * scale));
    const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
    let hits = 0;
    for (let i = 0; i < VIDEO_SAMPLES; i++) {
      const seeked = reached('seeked');
      video.currentTime = video.duration * (i + 0.5) / VIDEO_SAMPLES;
      await seeked;
      ctx.drawImage(video, 0, 0, w, h);
      if (isLightVideoFrame(measure(ctx.getImageData(0, 0, w, h).data, w, h))) hits++;
    }
    return hits >= VIDEO_SAMPLES - 1;
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
  return { ...measure(data, w, h), sides: paleSides(data, w, h), around: darkPanelKind(data, w, h) };
}

// Some screenshots are a white page with dark panels and photos on it. Inverting the
// whole image would turn those panels white, so only the page gets darkened. This is
// slower and needs a bigger image, so it only runs on images that come close: mostly
// pale but not flat enough to pass, or passing but with a lot of dark in them.
const PARTIAL_SIZE = 1600;
const PARTIAL_MIN_LIGHT = 0.45;
const PARTIAL_THIN_LINE = 2;

function mayBePartial(stats) {
  if (stats.tinted < PARTIAL_MIN_LIGHT || stats.colorful > 0.25) return false;
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
  return { mask, share: share / n, ink: ink / page };
}

function isPartialScreenshot({ share, ink }) {
  return share >= 0.4 && share <= 0.95 && ink >= 0.02;
}

// mayBeFrame already looked at the shape, and a frame may have no text on it.
function isFrameScreenshot({ share }) {
  return share >= 0.03 && share <= 0.5;
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

// A dark panel shown off on something bright that isn't a page: a blurred screenshot
// behind it, or a photo under a browser's pale toolbar. The panel stays as it is.
const PANEL_GRID = 24;
const PANEL_MIN_AREA = 0.05;
const BAR_MIN = 0.03, BAR_MAX = 0.25;

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

function darkPanelKind(data, width, height) {
  const panel = findPanel(data, width, height);
  const bar = topBar(data, width, height);
  // A panel floats. A dark photo under a meme's caption runs to the edges of the image.
  const floats = panel && panel.x0 > width * 0.01 && panel.x1 < width * 0.99 && panel.y1 < height * 0.99;
  if (floats && bar >= BAR_MIN && bar <= BAR_MAX && panel.y0 >= height * bar - 2) return 'bar';
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
  if (kind === 'bar') {
    // A few rows more for the toolbar's soft bottom edge.
    const bar = Math.round(topBar(data, w, h) * h) + 3;
    darkCtx.filter = DARK_FILTER;
    darkCtx.drawImage(bitmap, 0, 0, w, h);
    darkCtx.filter = 'none';
    darkCtx.clearRect(0, bar, w, h - bar);
  } else {
    const box = sharpBox(data, w, h);
    if (!box || darkPanelKind(data, w, h) !== 'blur') { bitmap.close(); return null; }
    // The blur is a washed-out page, mid-gray where it was white, and inverting mid-gray
    // leaves it mid-gray. Bringing its brightest back up to white first makes it go dark.
    // Blurred photos would turn into bright negatives, so each pixel gets whichever is
    // darker, itself or its dark version. Nothing gets brighter and no edges show.
    const stretch = Math.min(2.4, 255 / peakAround(data, w, h, box));
    darkCtx.drawImage(bitmap, 0, 0, w, h);
    darkCtx.globalCompositeOperation = 'darken';
    darkCtx.filter = `brightness(${stretch.toFixed(2)}) ${DARK_FILTER}`;
    darkCtx.drawImage(bitmap, 0, 0, w, h);
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
