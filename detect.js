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
  let light = 0, tinted = 0, flat = 0, colorful = 0;
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
      const right = x + 1 < width ? i + 4 : i;
      const down = y + 1 < height ? i + width * 4 : i;
      const diff = Math.abs(r - data[right]) + Math.abs(g - data[right + 1]) + Math.abs(b - data[right + 2]) +
        Math.abs(r - data[down]) + Math.abs(g - data[down + 1]) + Math.abs(b - data[down + 2]);
      if (diff <= 6) flat++;
    }
  }
  return { light: light / total, tinted: tinted / total, flat: flat / total, colorful: colorful / total };
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
