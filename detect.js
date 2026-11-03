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
  return measure(ctx.getImageData(0, 0, w, h).data, w, h);
}

// Some screenshots are a white page with dark panels and photos on it. Inverting the
// whole image would turn those panels white, so only the page gets darkened. This is
// slower and needs a bigger image, so it only runs on images that come close: mostly
// pale but not flat enough to pass, or passing but with a lot of dark in them.
const PARTIAL_SIZE = 1600;
const PARTIAL_MIN_LIGHT = 0.45;

function mayBePartial(stats) {
  if (stats.tinted < PARTIAL_MIN_LIGHT || stats.colorful > 0.25) return false;
  return !isLightScreenshot(stats, true) || stats.dark >= 0.06;
}

// With the tinted setting off, a cream page isn't darkened.
function usesPartial(stats, allowTinted) {
  return !!stats?.partial && (allowTinted || stats.light >= PARTIAL_MIN_LIGHT);
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
    found(0, end);
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
  const mask = new Uint8Array(n).fill(1);
  let kept = 0;
  eachGroup(other, width, queue, (start, end) => {
    if (end - start < n * 0.004) return;
    kept += end - start;
    // A white ceiling in a photo can run into a white page and bite into the group, so
    // a big group is squared off along the rows and columns it mostly fills.
    const rows = new Map(), cols = new Map();
    for (let i = start; i < end; i++) {
      const c = queue[i], x = c % width, y = (c - x) / width;
      mask[c] = 0;
      rows.set(y, (rows.get(y) || 0) + 1);
      cols.set(x, (cols.get(x) || 0) + 1);
    }
    if (end - start < n * 0.03) return;
    const ys = [...rows.keys()], xs = [...cols.keys()];
    const boxW = Math.max(...xs) - Math.min(...xs) + 1, boxH = Math.max(...ys) - Math.min(...ys) + 1;
    const fullX = xs.filter((x) => cols.get(x) >= boxH * 0.6), fullY = ys.filter((y) => rows.get(y) >= boxW * 0.6);
    if (!fullX.length || !fullY.length) return;
    const x0 = Math.min(...fullX), x1 = Math.max(...fullX), y0 = Math.min(...fullY), y1 = Math.max(...fullY);
    for (let y = y0; y <= y1; y++) mask.fill(0, y * width + x0, y * width + x1 + 1);
  });
  let share = 0;
  for (let i = 0; i < n; i++) share += mask[i];
  // Text and icons on the page are what separate a screenshot from a product on white.
  return { mask, share: share / n, ink: (n - page - kept) / page };
}

function isPartialScreenshot({ share, ink }) {
  return share >= 0.4 && share <= 0.95 && ink >= 0.02;
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

// Returns the partly dark picture as a data URL, or null if it isn't that kind of image.
async function partialDarken(blob) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, PARTIAL_SIZE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const picture = new OffscreenCanvas(w, h);
  const ctx = picture.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  const found = pageMask(ctx.getImageData(0, 0, w, h).data, w, h);
  if (!found || !isPartialScreenshot(found)) {
    bitmap.close();
    return null;
  }
  const mask = new OffscreenCanvas(w, h);
  const maskCtx = mask.getContext('2d');
  const pixels = maskCtx.createImageData(w, h);
  grown(found.mask, w).forEach((on, i) => { pixels.data[i * 4 + 3] = on ? 255 : 0; });
  maskCtx.putImageData(pixels, 0, 0);
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
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(out);
  });
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
