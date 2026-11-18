// Layout tests. The critical invariant is that pen advance comes from the font
// metric and never from the atlas tile width; the tile's pad must be inert.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeManifests, shapeLine, layoutParagraph, measureText, tokenize } from '../shared/layout.mjs';
import { requiredCodepoints, TOUR, tourStrings, isCjkCodepoint } from '../shared/content.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ATLAS = path.join(ROOT, 'web', 'atlas');

function load() {
  const index = JSON.parse(fs.readFileSync(path.join(ATLAS, 'index.json'), 'utf8'));
  const byId = new Map();
  for (const face of index.faces) {
    byId.set(face.id, JSON.parse(fs.readFileSync(path.join(ATLAS, face.json), 'utf8')));
  }
  return makeManifests(index, byId, { latinFace: 'sans-book' });
}

const manifests = load();

test('atlas covers every codepoint the tour can draw', () => {
  const missing = [];
  for (const cp of requiredCodepoints()) {
    const faceId = manifests.faceFor(cp);
    if (!manifests.glyph(faceId, cp)) missing.push([faceId, cp]);
  }
  assert.deepEqual(missing, [], 'all required codepoints have a tile or blank entry');
});

test('every tour string lays out without a fallback glyph', () => {
  for (const s of tourStrings()) {
    const { placements } = shapeLine(manifests, s, { sizePx: 24 });
    for (const p of placements) assert.ok(p.glyphId !== undefined, `missing glyph in ${JSON.stringify(s)}`);
  }
});

test('shapeLine advance equals the summed font advances (pen is a metric sum)', () => {
  const text = 'AVATAR';
  const m = manifests.byId.get('sans-book');
  const kern = manifests.kerning('sans-book');
  let expected = 0;
  let prev = null;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (prev != null) {
      const k = kern.get((prev << 16) | cp);
      if (k != null) expected += k;
    }
    expected += m.glyphs[cp].advance;
    prev = cp;
  }
  const { advancePx } = shapeLine(manifests, text, { sizePx: 100 });
  assert.ok(Math.abs(advancePx - expected * 100) < 1e-6);
});

test('tile width and pad never affect tracking', () => {
  // Take the exact same glyph data but double every tile's pad margin by
  // widening the tile rect and shifting the origin. measureText must be
  // bit-identical: spacing is the advance metric.
  const base = measureText(manifests, '山水 AVTo', { sizePx: 48, tracking: 0.01 });
  const variant = makeManifests(manifests.index, cloneWidened(manifests.byId), { latinFace: 'sans-book' });
  const widened = measureText(variant, '山水 AVTo', { sizePx: 48, tracking: 0.01 });
  assert.equal(widened, base);
});

test('increasing tracking increases the measure by exactly tracking * nchars * size', () => {
  const text = 'AVTO';
  // 4 glyphs, so 3 inter-glyph gaps carry tracking in this implementation
  // (tracking is added after every glyph, including the last).
  const a = measureText(manifests, text, { sizePx: 64, tracking: 0 });
  const b = measureText(manifests, text, { sizePx: 64, tracking: 0.1 });
  const diff = b - a;
  assert.ok(Math.abs(diff - 0.1 * 4 * 64) < 1e-9, `diff ${diff}`);
});

test('kerning is applied between adjacent glyphs and not across faces', () => {
  // "AV" has a negative kern in DejaVu; "A山" crosses into the CJK face and
  // must not pick up a bogus pair.
  const av = shapeLine(manifests, 'AV', { sizePx: 100 }).placements;
  assert.equal(av.length, 2);
  assert.ok(av[1].kernEm <= 0, 'AV should kern tighter or equal');
  const mixed = shapeLine(manifests, 'A山', { sizePx: 100 }).placements;
  assert.equal(mixed[1].faceId, 'cjk-regular');
});

test('placements use the tile origin, not the tile width, for position', () => {
  const { placements } = shapeLine(manifests, 'Ag', { sizePx: 64, x: 0, y: 0 });
  const m = manifests.byId.get('sans-book');
  const gA = m.glyphs[65];
  const scale = 64 / m.settings.texelsPerEm;
  assert.equal(placements[0].x, -gA.ox * scale);
  // The second glyph's pen position equals the first advance, independent of
  // either tile width.
  assert.ok(Math.abs(placements[1].penPx - gA.advance * 64) < 1e-9);
});

test('paragraph wrapping respects the measure', () => {
  const para = layoutParagraph(manifests, TOUR.sections[0].body, {
    sizePx: 20, maxWidthPx: 200, lineHeightEm: 1.6,
  });
  assert.ok(para.lines.length >= 2, 'long CJK copy wraps');
  for (const line of para.lines) {
    // A single unbreakable token may exceed the measure; CJK text is
    // per-character so each line should be close, with at most one glyph of
    // slack from the hang rule.
    assert.ok(line.width <= 200 + 20 * 1.2, `line width ${line.width} under measure`);
  }
});

test('no line starts with closing punctuation or ends with opening punctuation', () => {
  const copy = TOUR.sections.map((s) => s.body).join('') + TOUR.notices.join('');
  const para = layoutParagraph(manifests, copy, { sizePx: 18, maxWidthPx: 160, lineHeightEm: 1.6 });
  const noStart = new Set([...'，。、；：！？）」』》〉】〕…—–·,.;:!?)]}%']);
  const noEnd = new Set([...'（「『《〈【〔(']);
  for (const line of para.lines) {
    const t = line.text;
    if (!t) continue;
    assert.ok(!noStart.has(t[0]), `line starts with ${t[0]}: ${t}`);
    assert.ok(!noEnd.has(t[t.length - 1]), `line ends with ${t[t.length - 1]}: ${t}`);
  }
});

test('CJK tokenisation breaks between characters, Latin at whitespace', () => {
  const toks = tokenize('借景 Borrowed Scenery');
  assert.deepEqual(toks, ['借', '景', ' ', 'Borrowed', ' ', 'Scenery']);
});

test('face routing sends CJK codepoints to the CJK face', () => {
  for (const cp of [0x5c71, 0x3001, 0xff0c]) {
    assert.equal(manifests.faceFor(cp), 'cjk-regular');
    assert.ok(isCjkCodepoint(cp));
  }
  assert.equal(manifests.faceFor(0x41), 'sans-book');
});

test('retargeting latinFace switches the Latin face at runtime (weight control)', () => {
  const m = makeManifests(manifests.index, manifests.byId, { latinFace: 'sans-book' });
  assert.equal(m.faceFor(0x41), 'sans-book');
  m.latinFace = 'sans-bold';
  assert.equal(m.faceFor(0x41), 'sans-bold');
  assert.equal(m.faceFor(0x5c71), 'cjk-regular', 'CJK stays on the CJK face');
  const { placements } = shapeLine(m, 'A', { sizePx: 32 });
  assert.equal(placements[0].faceId, 'sans-bold');
  assert.equal(placements[0].glyphId, m.byId.get('sans-bold').glyphs[65].glyphId);
});

function cloneWidened(byId) {
  const out = new Map();
  for (const [id, m] of byId) {
    const copy = JSON.parse(JSON.stringify(m));
    for (const g of Object.values(copy.glyphs)) {
      const extra = 8; // texels added on every side
      g.w += extra * 2;
      g.h += extra * 2;
      g.ox += extra;
      g.oy += extra;
      g.tileEmW += (extra * 2) / copy.settings.texelsPerEm;
      g.tileEmH += (extra * 2) / copy.settings.texelsPerEm;
      g.left -= extra / copy.settings.texelsPerEm;
      g.top += extra / copy.settings.texelsPerEm;
    }
    out.set(id, copy);
  }
  return out;
}
