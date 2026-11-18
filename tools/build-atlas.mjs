#!/usr/bin/env node
// Build the distributable-font SDF atlas for the pavilion tour.
//
//   node tools/build-atlas.mjs [--texels-per-em 64] [--range 16] [--pad 24]
//                              [--only faceId] [--out web/atlas]
//
// Writes one R8 PNG + one JSON manifest per face, plus outlines.json (the
// vector source the GUI editor and the comparison report use), and an index.
// This is the only artifact producer; the runtime never rasterises text.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import * as fontkit from 'fontkit';
import { FACES } from '../shared/fontface.mjs';
import { buildAtlas, DEFAULT_SETTINGS, normalizeSettings } from '../shared/atlas-core.mjs';
import { requiredCodepoints, TOUR, isCjkCodepoint } from '../shared/content.mjs';
import { flattenOutline } from '../shared/geometry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FONT_DIR = path.join(ROOT, 'assets', 'fonts');

const FACE_BUILD = {
  'sans-thin': { texelsPerEm: 64, rangeTexels: 10, padTexels: 16 },
  'sans-book': { texelsPerEm: 64, rangeTexels: 10, padTexels: 16 },
  'sans-bold': { texelsPerEm: 64, rangeTexels: 10, padTexels: 16 },
  'cjk-regular': { texelsPerEm: 64, rangeTexels: 10, padTexels: 16 },
};

function parseArgs(argv) {
  const out = { out: path.join(ROOT, 'web', 'atlas') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--texels-per-em') out.texelsPerEm = Number(argv[++i]);
    else if (a === '--range') out.rangeTexels = Number(argv[++i]);
    else if (a === '--pad') out.padTexels = Number(argv[++i]);
    else if (a === '--only') out.only = argv[++i];
    else if (a === '--out') out.out = path.resolve(argv[++i]);
    else if (a === '--help' || a === '-h') { out.help = true; }
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function hashFile(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function writePng(file, width, height, data) {
  const png = new PNG({ width, height, colorType: 0 });
  png.data = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const buf = PNG.sync.write(png, { colorType: 0, inputColorType: 0, inputHasAlpha: false });
  fs.writeFileSync(file, buf);
  return buf.length;
}

function outlinesFor(font, codepoints) {
  const upm = font.unitsPerEm;
  const out = {};
  for (const cp of codepoints) {
    const g = font.glyphForCodePoint(cp);
    if (!g) continue;
    const cmds = [];
    for (const c of g.path.commands) {
      cmds.push({ c: c.command, a: c.args.map((v) => Math.round(v * 1000) / 1000 / upm) });
    }
    out[cp] = {
      cp,
      glyphId: g.id,
      advance: g.advanceWidth / upm,
      bbox: g.bbox ? {
        minX: g.bbox.minX / upm, minY: g.bbox.minY / upm,
        maxX: g.bbox.maxX / upm, maxY: g.bbox.maxY / upm,
      } : null,
      cmds,
    };
  }
  return out;
}

// Codepoints for a face: CJK face gets CJK codepoints, Latin faces get the rest.
function codepointsForFace(faceId, all) {
  const cjk = faceId === 'cjk-regular';
  return all.filter((cp) => isCjkCodepoint(cp) === cjk);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node tools/build-atlas.mjs [--texels-per-em N] [--range N] [--pad N] [--only face] [--out dir]');
    return;
  }
  const outDir = args.out;
  fs.mkdirSync(outDir, { recursive: true });

  const resolve = (_faceId, file) => fontkit.openSync(path.join(FONT_DIR, file));
  const allCps = requiredCodepoints();
  const faces = args.only ? [args.only] : Object.keys(FACES);
  if (args.only && !FACES[args.only]) throw new Error(`unknown face: ${args.only} (known: ${Object.keys(FACES).join(', ')})`);

  const index = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    generator: 'tools/build-atlas.mjs',
    conventions: {
      distance: 'R8: 128 = edge, 255 = +rangeTexels inside, 0 = -rangeTexels outside',
      placement: 'tile rect includes pad; advance is a separate font metric and is never used as tracking',
      yAxis: 'glyph space is y-up; tile y=0 is the top of the tile',
      pooling: 'bilinear; border texels saturate so adjacent tiles cannot bleed',
      ligatures: 'the runtime lays out code points + pair kerning; no ligature substitution',
    },
    faces: [],
  };
  const outlines = {};
  const report = [];

  for (const faceId of faces) {
    const spec = FACES[faceId];
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      ...(FACE_BUILD[faceId] || {}),
      ...(args.texelsPerEm ? { texelsPerEm: args.texelsPerEm } : {}),
      ...(args.rangeTexels ? { rangeTexels: args.rangeTexels } : {}),
      ...(args.padTexels ? { padTexels: args.padTexels } : {}),
      maxWidth: 4096, maxHeight: 4096,
    });
    const cps = codepointsForFace(faceId, allCps);
    const t0 = performance.now();
    const result = buildAtlas({ faceId, resolve, codepoints: cps, settings });
    const ms = performance.now() - t0;
    const font = resolve(faceId, spec.file);
    outlines[faceId] = outlinesFor(
      spec.variable ? font.getVariation({ [spec.variable.axis]: spec.weight }) : font,
      Object.keys(result.glyphs).map(Number),
    );

    const pngName = `${faceId}.png`;
    const binName = `${faceId}.r8`;
    const jsonName = `${faceId}.json`;
    const pngBytes = writePng(path.join(outDir, pngName), result.atlas.width, result.atlas.height, result.pixels);
    // Raw R8 payload is the canonical GPU upload source. The PNG is a human-
    // inspectable copy and a fallback; reading a grayscale PNG back through a
    // browser can be affected by colour management, and the field is not a
    // colour, so the runtime prefers this .r8 file.
    fs.writeFileSync(path.join(outDir, binName), Buffer.from(result.pixels.buffer, result.pixels.byteOffset, result.pixels.byteLength));
    const atlasSha = crypto.createHash('sha256').update(result.pixels).digest('hex');

    const { pixels, ...manifest } = result;
    manifest.faceMeta = {
      id: faceId,
      label: spec.label,
      family: spec.family,
      requestedWeight: spec.weight,
      style: spec.style,
      license: spec.license,
      sourceFile: spec.file,
      sourceSha256: hashFile(path.join(FONT_DIR, spec.file)),
    };
    manifest.image = {
      file: pngName, r8: binName, width: result.atlas.width, height: result.atlas.height,
      sha256: atlasSha, pngBytes,
    };
    manifest.kerning = compactKerning(result.kerning);
    manifest.glyphCount = Object.keys(result.glyphs).length;
    fs.writeFileSync(path.join(outDir, jsonName), JSON.stringify(manifest));

    index.faces.push({
      id: faceId, label: spec.label, family: spec.family, weight: spec.weight,
      json: jsonName, png: pngName, r8: binName, glyphCount: manifest.glyphCount,
      atlas: { width: result.atlas.width, height: result.atlas.height, pixels: result.pixels.length, pngBytes, sha256: atlasSha },
      settings,
      missing: result.missing,
      buildMs: Math.round(ms),
    });

    const mb = (result.pixels.length / (1024 * 1024)).toFixed(2);
    const pngKb = (pngBytes / 1024).toFixed(0);
    console.log(
      `${faceId.padEnd(12)} ${String(manifest.glyphCount).padStart(3)} glyphs  ` +
      `${result.atlas.width}x${result.atlas.height}  R8 ${mb} MB PNG ${pngKb} KB  ` +
      `kerning ${result.kerning.length} pairs  ${ms.toFixed(0)} ms` +
      (result.missing.length ? `  missing ${result.missing.length}` : ''),
    );
    if (result.missing.length) console.log(`  missing cps: ${result.missing.map((c) => 'U+' + c.toString(16).toUpperCase()).join(' ')}`);
    report.push({ faceId, ms, result });
  }

  // toursample expectations let the test suite assert coverage of every string.
  index.tourStrings = TOUR;
  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index, null, 2));
  fs.writeFileSync(path.join(outDir, 'outlines.json'), JSON.stringify({ schema: 1, units: 'em', faces: outlines }));
  const totalPng = index.faces.reduce((s, f) => s + f.atlas.pngBytes, 0);
  const totalPx = index.faces.reduce((s, f) => s + f.atlas.pixels, 0);
  console.log(`atlas total: ${(totalPx / (1024 * 1024)).toFixed(2)} MB R8, ${(totalPng / 1024).toFixed(0)} KB PNG -> ${outDir}`);
}

function compactKerning(pairs) {
  // "a,b,value" triples for all non-zero pairs; values in em (6 dp).
  return pairs.map((p) => [p.a, p.b, Math.round(p.valueEm * 1e6) / 1e6]);
}

main();
