#!/usr/bin/env node
// Comparative report: SDF atlas sampling (bilinear, same decode and coverage
// formula as the shader) vs exact nonzero-winding outline rasterisation, for
// thin / regular / bold / punctuation / large-zoom samples. Writes a Markdown
// report with per-glyph, per-size error metrics and atlas sizes, plus PNG crops
// for visual inspection.
//
//   node tools/compare-report.mjs [--out docs/report]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { sampleTileBilinear, decodeDistance, coverageFromPixels } from '../shared/sdf.mjs';
import { rasterizeCoverage, compareCoverage } from '../shared/raster.mjs';
import { flattenOutline } from '../shared/geometry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ATLAS = path.join(ROOT, 'web', 'atlas');

const SIZES = [12, 16, 24, 48, 96, 192];
const SAMPLE_GLYPHS = {
  'sans-thin': [0x41, 0x57, 0x61, 0x69, 0x2e, 0x2c, 0x3a, 0x40],
  'sans-book': [0x41, 0x57, 0x61, 0x69, 0x2e, 0x2c, 0x3a, 0x40],
  'sans-bold': [0x41, 0x57, 0x61, 0x69, 0x2e, 0x2c, 0x3a, 0x40],
  'cjk-regular': [0x5c71, 0x5c55, 0x95f4, 0x3001, 0x3002, 0xff0c],
};

function loadAtlas(faceId) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ATLAS, `${faceId}.json`), 'utf8'));
  const png = PNG.sync.read(fs.readFileSync(path.join(ATLAS, `${faceId}.png`)));
  const data = new Uint8Array(png.width * png.height);
  // pngjs decodes 8-bit grayscale into RGBA-ish buffer; colorType 0 has one byte.
  if (png.data.length === png.width * png.height) data.set(png.data);
  else for (let i = 0; i < data.length; i++) data[i] = png.data[i * (png.data.length / data.length)];
  return { manifest, width: png.width, height: png.height, data };
}

function glyphTile(manifest, atlasData, cp) {
  const g = manifest.glyphs[cp];
  if (!g) return null;
  const tw = g.w, th = g.h;
  const buf = new Uint8Array(tw * th);
  for (let y = 0; y < th; y++) {
    const src = (g.y + y) * atlasData.width + g.x;
    buf.set(atlasData.data.subarray(src, src + tw), y * tw);
  }
  return { width: tw, height: th, data: buf };
}

// Render a glyph from its SDF tile at `sizePx`, aligned to the reference
// rasteriser's coordinate space. One sample per pixel at the pixel centre,
// exactly as the fragment shader does (no supersampling): this models the GPU
// path, so the reported error is the error a viewer would actually see.
function sdfCoverage(g, tile, sizePx, canvasW, canvasH, originX, originY, manifest) {
  const scale = sizePx / manifest.settings.texelsPerEm; // tile texels -> px
  const out = new Float32Array(canvasW * canvasH);
  for (let py = 0; py < canvasH; py++) {
    for (let px = 0; px < canvasW; px++) {
      const xPx = px + 0.5;
      const yPx = py + 0.5;
      // tile pixel coordinates: tile top-left is at (originX, originY) in this bitmap
      const u = (xPx - originX) / scale;
      const v = (yPx - originY) / scale;
      // bilinear on byte values, then decode; this stays in tile texel space
      const byte = sampleTileBilinear(tile, u, v);
      const dTexels = decodeDistance(byte, manifest.settings.rangeTexels);
      const dPx = (dTexels / manifest.settings.texelsPerEm) * sizePx;
      out[py * canvasW + px] = coverageFromPixels(dPx, 1.0);
    }
  }
  return out;
}

function outlineContours(outlines, faceId, cp) {
  const entry = outlines.faces[faceId]?.[cp];
  if (!entry) return null;
  return flattenOutline(entry.cmds.map((c) => ({ command: c.c, args: c.a })), 0.002);
}

function writeGrayCrop(file, width, height, bufs, labels) {
  // composite: each buffer as a strip; simple layout, no text labels in pixels.
  const strip = height;
  const png = new PNG({ width, height: height * bufs.length, colorType: 6 });
  for (let b = 0; b < bufs.length; b++) {
    const buf = bufs[b];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const v = Math.round(Math.max(0, Math.min(1, buf[y * width + x])) * 255);
      const o = ((b * height + y) * width + x) * 4;
      png.data[o] = v; png.data[o + 1] = v; png.data[o + 2] = v; png.data[o + 3] = 255;
    }
  }
  fs.writeFileSync(file, PNG.sync.write(png));
  return { width, height: strip * bufs.length };
}

function fmt(n, d = 4) { return n.toFixed(d); }

function main() {
  const outDir = path.join(ROOT, 'docs', 'report');
  fs.mkdirSync(outDir, { recursive: true });
  const outlines = JSON.parse(fs.readFileSync(path.join(ATLAS, 'outlines.json'), 'utf8'));
  const index = JSON.parse(fs.readFileSync(path.join(ATLAS, 'index.json'), 'utf8'));

  const lines = [];
  const W = (s = '') => lines.push(s);
  W('# 距离场字形图集：误差与尺寸报告');
  W();
  W('本报告由 `tools/compare-report.mjs` 生成。它将图集的 R8 距离场按着色器相同的解码与');
  W('覆盖函数（`shared/sdf.mjs` 的 `decodeDistance` / `coverageFromPixels`）重建，');
  W('与**精确非零环绕轮廓光栅化**（`shared/raster.mjs`，每像素 8 条子扫描线）逐像素比较。');
  W('两条路径的算法不同，因此一致性是证据而非同义反复。');
  W();
  W('坐标：SDF 侧与片元着色器一致，每像素中心采样一次（不做超采样），');
  W('因此报告的是观者真正看到的误差；轮廓侧每像素 8 条子扫描线，横向精确覆盖。');
  W('两者都在同一位图网格上、以字形原点为基准对齐。');
  W();
  W('指标：MAE（全图平均绝对覆盖误差）、RMSE、MaxErr、IoU（α≥0.5 的并交比）、');
  W('EdgeMAE（只统计轮廓附近 2%<α<98% 的像素，反映边缘质量）。');
  W();

  W('## 图集尺寸');
  W();
  W('| 字体 | 字重 | 字形数 | 图集 (px) | R8 像素 | PNG 文件 | 编码范围 | 边距 | 每 em 采样 |');
  W('|---|---|---|---|---|---|---|---|---|');
  for (const f of index.faces) {
    const m = JSON.parse(fs.readFileSync(path.join(ATLAS, f.json), 'utf8'));
    W(`| ${m.faceLabel} | ${f.weight} | ${f.glyphCount} | ${f.atlas.width}×${f.atlas.height} | ` +
      `${(f.atlas.pixels / 1048576).toFixed(2)} MB | ${(f.atlas.pngBytes / 1024).toFixed(0)} KB | ` +
      `±${f.settings.rangeTexels} texel | ${f.settings.padTexels} texel | ${f.settings.texelsPerEm} |`);
  }
  const totalPx = index.faces.reduce((s, f) => s + f.atlas.pixels, 0);
  const totalPng = index.faces.reduce((s, f) => s + f.atlas.pngBytes, 0);
  W(`| **合计** | | ${index.faces.reduce((s, f) => s + f.glyphCount, 0)} | | ` +
    `**${(totalPx / 1048576).toFixed(2)} MB** | **${(totalPng / 1024).toFixed(0)} KB** | | | |`);
  W();
  W('注：R8 是 GPU 上传纹理的原始大小；PNG 是磁盘分发大小。二者都列出，避免把任一当作另一。');
  W();

  const summary = [];
  const crops = [];

  for (const faceId of Object.keys(SAMPLE_GLYPHS)) {
    const faceInfo = index.faces.find((f) => f.id === faceId);
    if (!faceInfo) continue;
    const { manifest, width, height, data } = loadAtlas(faceId);
    const atlasData = { width, height, data };
    W(`## ${manifest.faceLabel}（${faceId}，字重 ${manifest.faceMeta.requestedWeight}）`);
    W();
    W('| 字形 | 尺寸 px | MAE | RMSE | MaxErr | IoU | EdgeMAE | 边缘像素 |');
    W('|---|---|---|---|---|---|---|---|');
    for (const cp of SAMPLE_GLYPHS[faceId]) {
      const g = manifest.glyphs[cp];
      if (!g) continue;
      const contours = outlineContours(outlines, faceId, cp);
      if (!contours) continue;
      const tile = glyphTile(manifest, atlasData, cp);
      const ch = String.fromCodePoint(cp);
      const glyphName = cp > 0x2e80 ? `“${ch}” U+${cp.toString(16).toUpperCase()}` : `“${ch}”`;
      for (const sizePx of SIZES) {
        // reference canvas covers the tile plus a 2 px margin
        const margin = 2;
        const canvasW = Math.ceil(g.w * (sizePx / manifest.settings.texelsPerEm)) + margin * 2;
        const canvasH = Math.ceil(g.h * (sizePx / manifest.settings.texelsPerEm)) + margin * 2;
        const sdfScale = sizePx / manifest.settings.texelsPerEm;
        // SDF tile top-left in this canvas: margin. Origin (pen) is at pad from
        // ink bounds; the reference rasteriser draws relative to the tile's
        // top-left em corner, i.e. (left, top).
        const originX = margin, originY = margin;
        const ref = rasterizeCoverage(contours, {
          width: canvasW, height: canvasH,
          ox: originX - g.left * sizePx,
          oy: originY + g.top * sizePx,
          scale: sizePx, subsamples: 8,
        });
        const sdf = sdfCoverage(g, tile, sizePx, canvasW, canvasH, originX, originY, manifest);
        const metrics = compareCoverage(ref, sdf, canvasW, canvasH);
        W(`| ${glyphName} | ${sizePx} | ${fmt(metrics.mae)} | ${fmt(metrics.rmse)} | ` +
          `${fmt(metrics.maxErr, 3)} | ${fmt(metrics.iou, 3)} | ${fmt(metrics.edgeMae)} | ${metrics.edgePixels} |`);
        summary.push({ faceId, cp, sizePx, ...metrics });
        if (sizePx === 12 || sizePx === 48 || sizePx === 192) {
          if (cp === SAMPLE_GLYPHS[faceId][0] || cp === 0x2e || cp === 0x3001) {
            crops.push({ faceId, cp, ch, sizePx, ref, sdf, w: canvasW, h: canvasH });
          }
        }
      }
    }
    W();
  }

  // Aggregate conclusions computed from data, not asserted.
  const bySize = new Map();
  for (const s of summary) {
    if (!bySize.has(s.sizePx)) bySize.set(s.sizePx, []);
    bySize.get(s.sizePx).push(s);
  }
  W('## 按字号汇总');
  W();
  W('| 尺寸 px | MAE | RMSE | EdgeMAE | 平均 IoU |');
  W('|---|---|---|---|---|');
  for (const sizePx of SIZES) {
    const rows = bySize.get(sizePx) || [];
    if (!rows.length) continue;
    const avg = (k) => rows.reduce((s, r) => s + r[k], 0) / rows.length;
    W(`| ${sizePx} | ${fmt(avg('mae'))} | ${fmt(avg('rmse'))} | ${fmt(avg('edgeMae'))} | ${fmt(avg('iou'), 3)} |`);
  }
  W();

  // Support boundary statement backed by measured error at the smallest size.
  const smallest = SIZES[0];
  const worstSmall = summary.filter((s) => s.sizePx === smallest).sort((a, b) => b.edgeMae - a.edgeMae)[0];
  W('## 支持边界');
  W();
  W(`- 最小测试字号 ${smallest} px 时，图集为 ${index.faces[0].settings.texelsPerEm} texel/em，`);
  W(`  每屏幕像素约对应 ${(index.faces[0].settings.texelsPerEm / smallest).toFixed(1)} 个图集 texel，距离场仍有冗余；`);
  W(`  最差 EdgeMAE 为 ${fmt(worstSmall.edgeMae)}（${worstSmall.faceId} U+${worstSmall.cp.toString(16).toUpperCase()}）。`);
  const large = SIZES[SIZES.length - 1];
  const largeRows = summary.filter((s) => s.sizePx === large);
  const largeAvgEdge = largeRows.reduce((s, r) => s + r.edgeMae, 0) / largeRows.length;
  W(`- 放大到 ${large} px 时，每个图集 texel 被拉伸到 ${(large / index.faces[0].settings.texelsPerEm).toFixed(2)} 屏幕像素，`);
  W(`  双线性插值使边缘出现 ${(large / index.faces[0].settings.texelsPerEm).toFixed(2)} px 量级的线性过渡，平均 EdgeMAE ${fmt(largeAvgEdge)}。`);
  W('  这是距离场采样的固有带宽限制：场值仍正确，但梯度被插值平滑，尖角会轻微圆化。');
  W('  因此“边缘一致”仅指**每个尺寸使用同一 1 px 屏幕空间阈值与同一覆盖公式**，');
  W('  不声称任意放大倍率下与轮廓光栅化逐像素相同；上面的数字给出实际偏差。');
  const thin = summary.filter((s) => s.faceId === 'sans-thin');
  const bold = summary.filter((s) => s.faceId === 'sans-bold');
  const avgThin = thin.reduce((s, r) => s + r.iou, 0) / thin.length;
  const avgBold = bold.reduce((s, r) => s + r.iou, 0) / bold.length;
  W(`- 细字（ExtraLight）平均 IoU ${fmt(avgThin, 3)}，粗字（Bold）平均 IoU ${fmt(avgBold, 3)}。`);
  W('  细笔画的相对误差更高，这是距离场在细笔画两侧只有少量 texel 采样导致的；');
  W('  提高 `--texels-per-em` 可缩小该误差，代价是图集线性增大。');
  W();

  W('## 样本图');
  W();
  W('`docs/report/*.png`：每张为两行条带——上排为精确轮廓光栅化，下排为距离场重建。');
  W('灰度即覆盖度 0–255。');
  W();
  fs.writeFileSync(path.join(outDir, 'REPORT.md'), lines.join('\n'));
  for (const c of crops) {
    const file = path.join(outDir, `${c.faceId}-U${c.cp.toString(16).toUpperCase()}-${c.sizePx}px.png`);
    writeGrayCrop(file, c.w, c.h, [c.ref, c.sdf]);
  }
  const metrics = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    sizes: SIZES,
    atlas: index.faces.map((f) => ({
      id: f.id, label: f.label, weight: f.weight, glyphCount: f.glyphCount,
      width: f.atlas.width, height: f.atlas.height, pixels: f.atlas.pixels,
      pngBytes: f.atlas.pngBytes, settings: f.settings, buildMs: f.buildMs,
    })),
    totals: {
      r8Bytes: index.faces.reduce((s, f) => s + f.atlas.pixels, 0),
      pngBytes: index.faces.reduce((s, f) => s + f.atlas.pngBytes, 0),
      glyphs: index.faces.reduce((s, f) => s + f.glyphCount, 0),
    },
    bySize: SIZES.map((sizePx) => {
      const rows = summary.filter((s) => s.sizePx === sizePx);
      const avg = (k) => rows.reduce((s, r) => s + r[k], 0) / Math.max(1, rows.length);
      return { sizePx, mae: avg('mae'), rmse: avg('rmse'), edgeMae: avg('edgeMae'), iou: avg('iou'), rows: rows.length };
    }),
    byFace: [...new Set(summary.map((s) => s.faceId))].map((faceId) => {
      const rows = summary.filter((s) => s.faceId === faceId);
      const avg = (k) => rows.reduce((s, r) => s + r[k], 0) / Math.max(1, rows.length);
      return { faceId, mae: avg('mae'), edgeMae: avg('edgeMae'), iou: avg('iou') };
    }),
    samples: summary,
    crops: crops.map((c) => ({
      faceId: c.faceId, cp: c.cp, char: c.ch, sizePx: c.sizePx, width: c.w, height: c.h,
      file: `${c.faceId}-U${c.cp.toString(16).toUpperCase()}-${c.sizePx}px.png`,
    })),
    supportBoundary: {
      minPx: SIZES[0], maxPx: SIZES[SIZES.length - 1],
      statement: '同一 1 px 屏幕空间阈值与同一覆盖公式适用于所有尺寸；放大到超过图集密度时，边缘因双线性插值而平滑，误差见样本。',
    },
  };
  fs.writeFileSync(path.join(outDir, 'metrics.json'), JSON.stringify(metrics, null, 1));
  console.log(`metrics: ${path.join(outDir, 'metrics.json')}`);
  console.log(`report: ${path.join(outDir, 'REPORT.md')}`);
  console.log(`samples: ${crops.length} PNG strips`);
  const overall = summary.reduce((s, r) => s + r.mae, 0) / summary.length;
  console.log(`rows: ${summary.length}, mean MAE: ${overall.toFixed(5)}`);
}

main();
