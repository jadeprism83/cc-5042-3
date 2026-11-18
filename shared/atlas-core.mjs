// Node-side extraction layer: pull glyph outlines from a fontkit face and hand
// them to the browser-safe atlas builder. Kept separate from
// shared/atlas-build.mjs so the browser editor can use the same builder without
// importing fontkit.
import { getFont, glyphContours, faceError, FACES } from './fontface.mjs';
import { buildAtlasFromSources, normalizeSettings, DEFAULT_SETTINGS } from './atlas-build.mjs';
import { requiredCodepoints, isCjkCodepoint } from './content.mjs';

export { DEFAULT_SETTINGS, normalizeSettings };

export function glyphSourceFromFont(font, cp, band) {
  const g = font.glyphForCodePoint(cp);
  if (!g || !g.path) return null;
  const upm = font.unitsPerEm;
  const cmds = g.path.commands.map((c) => ({ c: c.command, a: c.args.map((v) => v / upm) }));
  return {
    cp,
    glyphId: g.id,
    advance: g.advanceWidth / upm,
    cmds,
    band: band ?? (isCjkCodepoint(cp) ? 'cjk' : 'latin'),
  };
}

export function extractKerning(font, codepoints) {
  const cps = codepoints.filter((cp) => cp > 32 && cp < 0x3000);
  const pairs = [];
  const seen = new Set();
  for (const a of cps) {
    const ga = font.glyphForCodePoint(a);
    if (!ga) continue;
    for (const b of cps) {
      const key = (a << 16) | b;
      if (seen.has(key)) continue;
      seen.add(key);
      const run = font.layout(String.fromCodePoint(a, b));
      if (run.glyphs.length !== 2 || run.positions.length !== 2) continue;
      const gb = font.glyphForCodePoint(b);
      if (!gb) continue;
      const expected = ga.advanceWidth + gb.advanceWidth;
      const actual = run.positions[0].xAdvance + run.positions[1].xAdvance;
      const delta = actual - expected;
      if (delta !== 0) pairs.push({ a, b, valueEm: delta / font.unitsPerEm });
    }
  }
  return pairs;
}

export function buildAtlas(opts) {
  const { faceId, resolve, codepoints, settings: rawSettings, includeKerning = true } = opts;
  const settings = normalizeSettings(rawSettings);
  const font = getFont(faceId, resolve);
  const cps = (codepoints && codepoints.length) ? codepoints : requiredCodepoints();

  const sources = [];
  const missing = [];
  for (const cp of cps) {
    const src = glyphSourceFromFont(font, cp);
    if (!src) { missing.push(cp); continue; }
    sources.push(src);
  }
  const kerning = includeKerning ? extractKerning(font, sources.map((s) => s.cp)) : [];
  const result = buildAtlasFromSources({ faceId, glyphSources: sources, kerning, settings });
  // A variable font's name table describes its default master (here
  // "Noto Sans SC Thin"), which is not the weight actually instanced. Use the
  // face registry label so the manifest and report name the drawn weight.
  result.faceLabel = FACES[faceId]?.label || font.familyName;
  result.unitsPerEm = font.unitsPerEm;
  result.weight = font['OS/2'] ? font['OS/2'].usWeightClass : null;
  result.missing = missing;
  return result;
}
