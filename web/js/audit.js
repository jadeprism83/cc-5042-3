// Audit view. Reads docs/report/metrics.json, which is produced by the Node
// comparison tool. The browser does not recompute error numbers: one source of
// truth, one set of formulas.
import { decodeDistance, coverageFromPixels, sampleTileBilinear } from '../../shared/sdf.mjs';

const $ = (s) => document.querySelector(s);
const fmt = (n, d = 4) => (n == null ? '—' : Number(n).toFixed(d));

export async function initAudit({ state, showError }) {
  const body = $('#audit-body');
  let metrics;
  try {
    const res = await fetch('./report/metrics.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`metrics.json HTTP ${res.status}`);
    metrics = await res.json();
  } catch (err) {
    body.innerHTML = `<p>无法读取误差报告：${err.message}。请先运行 <code>npm run build</code>。</p>`;
    return;
  }
  state.metrics = metrics;

  const t = metrics.totals;
  const html = [];
  html.push('<h3>图集尺寸</h3>');
  html.push('<table><thead><tr><th>字体</th><th>字重</th><th>字形数</th><th>图集 px</th><th>R8 字节</th><th>PNG 字节</th><th>每 em 采样</th><th>编码范围</th><th>边距</th><th>构建 ms</th></tr></thead><tbody>');
  for (const f of metrics.atlas) {
    html.push(`<tr><td>${f.label}</td><td>${f.weight}</td><td>${f.glyphCount}</td>` +
      `<td class="mono">${f.width}×${f.height}</td><td class="mono">${(f.pixels / 1048576).toFixed(2)} MB</td>` +
      `<td class="mono">${(f.pngBytes / 1024).toFixed(0)} KB</td><td class="mono">${f.settings.texelsPerEm}</td>` +
      `<td class="mono">±${f.settings.rangeTexels}</td><td class="mono">${f.settings.padTexels}</td><td class="mono">${f.buildMs}</td></tr>`);
  }
  html.push(`<tr><td colspan="3"><b>合计</b></td><td></td><td class="mono"><b>${(t.r8Bytes / 1048576).toFixed(2)} MB</b></td>` +
    `<td class="mono"><b>${(t.pngBytes / 1024).toFixed(0)} KB</b></td><td colspan="4"></td></tr>`);
  html.push('</tbody></table>');
  html.push('<p class="caption">R8 是 GPU 纹理真实大小；PNG 是磁盘分发大小。两者都列出，任一都不是另一的替代品。</p>');

  html.push('<h3>按字号：距离场重建 vs 精确轮廓光栅化</h3>');
  html.push('<table><thead><tr><th>字号 px</th><th>MAE</th><th>RMSE</th><th>EdgeMAE</th><th>平均 IoU</th><th>样本数</th></tr></thead><tbody>');
  for (const r of metrics.bySize) {
    html.push(`<tr><td class="mono">${r.sizePx}</td><td class="mono">${fmt(r.mae)}</td><td class="mono">${fmt(r.rmse)}</td>` +
      `<td class="mono">${fmt(r.edgeMae)}</td><td class="mono">${fmt(r.iou, 3)}</td><td class="mono">${r.rows}</td></tr>`);
  }
  html.push('</tbody></table>');

  html.push('<h3>按字重</h3>');
  html.push('<table><thead><tr><th>字体</th><th>MAE</th><th>EdgeMAE</th><th>平均 IoU</th></tr></thead><tbody>');
  for (const r of metrics.byFace) {
    html.push(`<tr><td>${r.faceId}</td><td class="mono">${fmt(r.mae)}</td><td class="mono">${fmt(r.edgeMae)}</td><td class="mono">${fmt(r.iou, 3)}</td></tr>`);
  }
  html.push('</tbody></table>');

  html.push('<h3>支持边界</h3>');
  html.push(`<p class="caption">${metrics.supportBoundary.statement}</p>`);

  html.push('<h3>最差样本（各字号）</h3>');
  const worst = [...metrics.samples].sort((a, b) => b.edgeMae - a.edgeMae).slice(0, 8);
  html.push('<table><thead><tr><th>字体</th><th>字符</th><th>字号</th><th>EdgeMAE</th><th>IoU</th><th>MaxErr</th></tr></thead><tbody>');
  for (const s of worst) {
    html.push(`<tr><td>${s.faceId}</td><td class="mono">${String.fromCodePoint(s.cp)} U+${s.cp.toString(16).toUpperCase()}</td>` +
      `<td class="mono">${s.sizePx}</td><td class="mono">${fmt(s.edgeMae)}</td><td class="mono">${fmt(s.iou, 3)}</td><td class="mono">${fmt(s.maxErr, 3)}</td></tr>`);
  }
  html.push('</tbody></table>');

  html.push('<h3>样本图（上排精确轮廓，下排距离场）</h3>');
  html.push('<div class="audit-figures">');
  for (const c of metrics.crops) {
    html.push(`<figure><img src="./report/${c.file}" alt="${String.fromCodePoint(c.cp)} ${c.sizePx}px 对比" width="${c.width}" height="${c.height}" loading="lazy"/>` +
      `<figcaption>${c.faceId} · ${String.fromCodePoint(c.cp)} U+${c.cp.toString(16).toUpperCase()} · ${c.sizePx} px</figcaption></figure>`);
  }
  html.push('</div>');

  body.innerHTML = html.join('');
}
