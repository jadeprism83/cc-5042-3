// Pavilion tour layout. The copy, faces, sizes and positions are data; the
// renderer only draws glyph instances. Nothing here uses canvas fillText or the
// DOM for text: every visible character is an atlas instance.
import { makeManifests, layoutParagraph, shapeLine } from '../../shared/layout.mjs';
import { TOUR } from '../../shared/content.mjs';

export function buildTourScene(manifests, canvasW, canvasH, opts) {
  const base = Math.min(canvasW / 1440, canvasH / 900);
  const scale = opts.sizeScale ?? 1;
  const body = Math.round(19 * base * scale);
  const small = Math.round(12.5 * base * scale);
  const heading = Math.round(30 * base * scale);
  const margin = Math.round(72 * base);
  const measure = canvasW - margin * 2;
  const gap = Math.round(26 * base);

  const items = [];

  // Section 1: exhibition intro (body copy, wrapped)
  const intro = layoutParagraph(manifests, TOUR.meta.lead, {
    sizePx: body, maxWidthPx: Math.round(measure * 0.58), lineHeightEm: 1.7, tracking: opts.tracking ?? 0,
  });

  // Build draw list with absolute positions. Paragraphs return local coords;
  // translate them by (x, y) here.
  const pushParagraph = (para, x, y, manifestOverrides) => {
    for (const line of para.lines) {
      for (const p of line.placements) {
        items.push({ ...p, x: p.x + x, y: p.y + y, sizePx: para.sizePx, manifestOverrides });
      }
    }
    return para.height;
  };

  const titleX = margin;
  // The hairline sits above the hero; the hero then grows downward from a
  // baseline that is computed from its own size, so raising the size slider
  // pushes the rest of the page down instead of clipping the glyph at the top.
  const ruleY = Math.round(64 * base);
  const heroSize = Math.round(96 * base * scale);
  const titleY = ruleY + Math.round(34 * base) + heroSize * 0.78;

  // Hero glyph "展" drawn as an SDF instance at a large size.
  const hero = shapeLine(manifests, TOUR.hero, { sizePx: heroSize, x: margin, y: titleY });
  for (const p of hero.placements) items.push({ ...p, sizePx: heroSize });

  const rightX = margin + Math.round(measure * 0.66);
  const rightW = measure - Math.round(measure * 0.66);

  let y = titleY + heroSize * 0.22 + Math.round(28 * base);

  // Titles / subtitles use the paragraph layout with the CJK+Latin mix.
  const title = layoutParagraph(manifests, TOUR.meta.title, { sizePx: Math.round(34 * base * scale), maxWidthPx: measure * 0.6, lineHeightEm: 1.3 });
  y += pushParagraph(title, margin, y);
  const sub = layoutParagraph(manifests, TOUR.meta.subtitle, { sizePx: Math.round(15 * base * scale), maxWidthPx: measure * 0.6, lineHeightEm: 1.5 });
  y += Math.round(8 * base);
  y += pushParagraph(sub, margin, y);

  y += gap;
  y += pushParagraph(intro, margin, y) + gap;

  // Section blocks use the left column measure so they stop before the rule.
  const colW = Math.round(measure * 0.58);
  for (const sec of TOUR.sections) {
    const h = layoutParagraph(manifests, `${sec.no}  ${sec.heading}`, { sizePx: heading, maxWidthPx: colW, lineHeightEm: 1.25 });
    y += pushParagraph(h, margin, y) + Math.round(6 * base);
    const hen = layoutParagraph(manifests, sec.headingEn, { sizePx: small, maxWidthPx: colW, lineHeightEm: 1.4, tracking: 0.02 });
    y += pushParagraph(hen, margin, y) + Math.round(10 * base);
    const para = layoutParagraph(manifests, sec.body, { sizePx: body, maxWidthPx: colW, lineHeightEm: 1.7, tracking: opts.tracking ?? 0 });
    y += pushParagraph(para, margin, y) + gap;
    if (y > canvasH - margin) break;
  }

  // Right column: notices, floor plan caption, numerals, arrows.
  let ry = ruleY + Math.round(36 * base);
  const noticeSize = Math.round(14 * base * scale);
  const noticeHead = layoutParagraph(manifests, '参观须知 / Visitor Notes', { sizePx: small, maxWidthPx: rightW, lineHeightEm: 1.4, tracking: 0.03 });
  ry += pushParagraph(noticeHead, rightX, ry) + Math.round(8 * base);
  for (const n of TOUR.notices) {
    ry += pushParagraph(layoutParagraph(manifests, n, { sizePx: noticeSize, maxWidthPx: rightW, lineHeightEm: 1.65 }), rightX, ry) + Math.round(8 * base);
  }

  ry += gap;
  for (const cap of TOUR.captions) {
    ry += pushParagraph(layoutParagraph(manifests, cap, { sizePx: Math.round(12 * base * scale), maxWidthPx: rightW, lineHeightEm: 1.5 }), rightX, ry) + Math.round(4 * base);
  }

  ry += gap;
  const numerals = shapeLine(manifests, TOUR.numerals, { sizePx: Math.round(26 * base * scale), x: rightX, y: ry });
  for (const p of numerals.placements) items.push({ ...p, sizePx: Math.round(26 * base * scale) });
  ry += Math.round(44 * base * scale);
  const latin = shapeLine(manifests, TOUR.latinSample, { sizePx: Math.round(11 * base * scale), x: rightX, y: ry, tracking: 0.08 });
  for (const p of latin.placements) items.push({ ...p, sizePx: Math.round(11 * base * scale) });

  // Hairlines and column rule are vector draw calls, not text. Returned so the
  // renderer can draw them with the same canvas pass, under the glyphs.
  const rules = [
    { x1: margin, y1: ruleY, x2: margin + measure, y2: ruleY },
    { x1: rightX - 24 * base, y1: ruleY, x2: rightX - 24 * base, y2: canvasH - margin },
  ];

  return { items, rules, metrics: { base, body, margin, measure, ruleY } };
}

// Group items into draw batches by (face, size, colour). Sizes in the same
// batch are identical so one pxPerEm uniform is correct.
export function groupBatches(manifests, items, colorFor) {
  const byFaceSize = new Map();
  for (const it of items) {
    const key = `${it.faceId}|${it.sizePx}`;
    let g = byFaceSize.get(key);
    if (!g) { g = { faceId: it.faceId, manifest: manifests.byId.get(it.faceId), sizePx: it.sizePx, items: [] }; byFaceSize.set(key, g); }
    g.items.push(it);
  }
  return [...byFaceSize.values()].map((g) => ({ ...g, color: colorFor(g) }));
}
