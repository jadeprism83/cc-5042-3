// Atlas loader. Prefers the raw .r8 payload (exact bytes) and falls back to the
// PNG only if the binary is missing, reporting which path was taken so the UI
// can show it.
export async function loadIndex(base = './atlas') {
  const res = await fetch(`${base}/index.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`无法读取 index.json（HTTP ${res.status}）`);
  return res.json();
}

export async function loadManifest(base, face) {
  const res = await fetch(`${base}/${face.json}`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`无法读取 ${face.json}（HTTP ${res.status}）`);
  return res.json();
}

export async function loadPixels(base, face, manifest) {
  const w = face.atlas.width, h = face.atlas.height;
  try {
    const res = await fetch(`${base}/${face.r8}`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length !== w * h) throw new Error(`长度不符：${buf.length} ≠ ${w * h}`);
    return { data: buf, width: w, height: h, source: 'raw .r8' };
  } catch (err) {
    const res = await fetch(`${base}/${face.png}`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`距离场数据读取失败：${err.message}；PNG 回退也失败（HTTP ${res.status}）`);
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob);
    const off = new OffscreenCanvas(w, h);
    const ctx = off.getContext('2d', { colorSpace: 'srgb' });
    ctx.drawImage(bmp, 0, 0);
    const img = ctx.getImageData(0, 0, w, h).data;
    const data = new Uint8Array(w * h);
    for (let i = 0; i < data.length; i++) data[i] = img[i * 4];
    return { data, width: w, height: h, source: 'PNG fallback', manifest };
  }
}
