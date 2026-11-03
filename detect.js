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
const VIDEO_PART_SAMPLES = 12;
const VIDEO_PART_SHARE = 0.1;
const VIDEO_PART_HITS = 3;
const VIDEO_PART_SIZE = 480;
const VIDEO_TIMEOUT_MS = 15000;

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
  const hits = await countVideoFrames(previewUrl, VIDEO_SAMPLES, SAMPLE_SIZE, (data, w, h) => isLightVideoFrame(measure(data, w, h)));
  if (hits >= VIDEO_SAMPLES - 1) return true;
  if (!largerUrl || !await countPartFrames(previewUrl, SAMPLE_SIZE)) return false;
  return await countPartFrames(largerUrl, VIDEO_PART_SIZE) >= VIDEO_PART_HITS ? 'parts' : false;
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
  return { ...measure(data, w, h), sides: paleSides(data, w, h) };
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
  // Thin lines come off first, since a border or divider can join everything on the
  // page into one big thing.
  let solid = other;
  for (let i = 0; i < PARTIAL_THIN_LINE; i++) solid = shrunk(solid, width);
  let keep = new Uint8Array(n);
  const boxes = [];
  eachGroup(solid, width, queue, (start, end) => {
    if (end - start < n * 0.004) return;
    // A white ceiling in a photo can run into a white page and bite into the group, so
    // a big group is squared off along the rows and columns it mostly fills.
    const rows = new Map(), cols = new Map();
    for (let i = start; i < end; i++) {
      const c = queue[i], x = c % width, y = (c - x) / width;
      keep[c] = 1;
      rows.set(y, (rows.get(y) || 0) + 1);
      cols.set(x, (cols.get(x) || 0) + 1);
    }
    if (end - start < n * 0.03) return;
    const ys = [...rows.keys()], xs = [...cols.keys()];
    const boxW = Math.max(...xs) - Math.min(...xs) + 1, boxH = Math.max(...ys) - Math.min(...ys) + 1;
    const fullX = xs.filter((x) => cols.get(x) >= boxH * 0.6), fullY = ys.filter((y) => rows.get(y) >= boxW * 0.6);
    if (!fullX.length || !fullY.length) return;
    const x0 = Math.min(...fullX), x1 = Math.max(...fullX), y0 = Math.min(...fullY), y1 = Math.max(...fullY);
    // Anything less than mostly filled is several things still joined up, not one photo.
    if (end - start >= (x1 - x0 + 1) * (y1 - y0 + 1) * 0.6) boxes.push([x0, y0, x1, y1]);
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
  return mergeRegions(regions, width, height).filter((box) => finishRegion(box, data, pale, width, height));
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

// Keeps regions from flickering from one check to the next: a box that barely moved stays
// where it was, a new one waits for a second look, and one that's gone gets one more.
function steadyRegions(previous, found, first) {
  const steady = found.map((box) => {
    const known = previous.find((old) => overlap(old, box) >= Math.min(old.w * old.h, box.w * box.h) * 0.7);
    if (!known) return { ...box, seen: first ? 2 : 1, missed: 0 };
    const still = Math.abs(known.x - box.x) <= 1 && Math.abs(known.y - box.y) <= 1 &&
      Math.abs(known.w - box.w) <= 2 && Math.abs(known.h - box.h) <= 2;
    return { ...box, ...(still ? { x: known.x, y: known.y, w: known.w, h: known.h } : {}), seen: known.seen + 1, missed: 0 };
  });
  for (const old of previous) {
    if (old.missed < 1 && old.seen >= 2 && !steady.some((box) => overlap(old, box) > 0)) steady.push({ ...old, missed: old.missed + 1 });
  }
  return steady;
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
