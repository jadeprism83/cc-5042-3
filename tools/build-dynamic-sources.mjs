#!/usr/bin/env node
// Build the runtime on-demand glyph source pool.
//
// The fixed atlases only cover the tour copy + ASCII. When a visitor switches
// the guide language to text the atlases do not contain, the browser generates
// those glyphs at runtime into the bounded dynamic atlas — but the browser has
// no font parser, so this CLI extracts the extra codepoints' outlines from the
// distributable fonts ahead of time and writes web/atlas/dynamic-sources.json.
//
// The CLI only produces vector sources; runtime generation, caching, eviction
// and uploading all happen in the page through shared/dynamic-atlas.mjs.
// Codepoints absent from the font are intentionally omitted: the provider then
// renders an explicit placeholder instead of pretending coverage.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fontkit from 'fontkit';
import { FACES } from '../shared/fontface.mjs';
import { isCjkCodepoint } from '../shared/content.mjs';
import { normalizeSettings, DEFAULT_SETTINGS } from '../shared/atlas-build.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FONT_DIR = path.join(ROOT, 'assets', 'fonts');

// Language presets exercised by the dynamic-atlas view and its tests. Each is
// deliberately outside the fixed-atlas coverage in part, and the Korean preset
// includes codepoints the vendored fonts do not ship, so the placeholder path
// is observable without mocking anything.
export const LANGUAGE_PRESETS = {
  ru: {
    label: 'Русский',
    face: 'latin',
    samples: [
      'Горный павильон: выставка чернил и камня',
      'Тихий сад открывается с восходом солнца',
      'Пожалуйста, не трогайте экспонаты',
    ],
  },
  'zh-tw': {
    label: '繁體中文',
    face: 'cjk',
    samples: [
      '山間展館：借景、器物與時間的對話',
      '請於參觀時保持安靜，並勿觸碰展示櫃',
      '東側出口與無障礙電梯位於服務台旁邊',
    ],
  },
  ja: {
    label: '日本語',
    face: 'cjk',
    samples: [
      '山あいの館：借景と器物と時間',
      'しずかな庭は夜明けとともに開きます',
      '展示物には触れないでください',
    ],
  },
  ko: {
    label: '한국어',
    face: 'cjk',
    // Hangul syllables are not in Noto Sans SC subset: these stay missing and
    // must render as explicit placeholders.
    samples: [
      '산속 전시관: 빌린 풍경과 시간',
      '전시물에 손을 대지 마십시오',
    ],
  },
};

export function dynamicCodepoints() {
  const set = new Set();
  for (const preset of Object.values(LANGUAGE_PRESETS)) {
    for (const s of preset.samples) for (const ch of s) {
      const cp = ch.codePointAt(0);
      if (cp > 32) set.add(cp);
    }
  }
  return [...set].sort((a, b) => a - b);
}

function extractFace(faceId, codepoints) {
  const spec = FACES[faceId];
  const font0 = fontkit.openSync(path.join(FONT_DIR, spec.file));
  const font = spec.variable ? font0.getVariation({ [spec.variable.axis]: spec.weight }) : font0;
  const upm = font.unitsPerEm;
  const out = {};
  const missing = [];
  for (const cp of codepoints) {
    const g = font.glyphForCodePoint(cp);
    if (!g || !g.path || !g.path.commands.length) { missing.push(cp); continue; }
    out[cp] = {
      cp,
      glyphId: g.id,
      advance: g.advanceWidth / upm,
      cmds: g.path.commands.map((c) => ({ c: c.command, a: c.args.map((v) => v / upm) })),
    };
  }
  return { out, missing, unitsPerEm: upm };
}

export function buildDynamicSources() {
  const settings = normalizeSettings({ ...DEFAULT_SETTINGS });
  const cps = dynamicCodepoints();
  const cjkCps = cps.filter(isCjkCodepoint);
  // Codepoints outside the CJK routing ranges (e.g. Hangul syllables) are
  // attempted on *every* face and kept wherever the font actually ships them;
  // faces without the glyph report them as missing rather than misrouting.
  const otherCps = cps.filter((cp) => !isCjkCodepoint(cp));
  const faces = {};
  const missingByFace = {};
  for (const faceId of ['sans-thin', 'sans-book', 'sans-bold']) {
    const { out, missing } = extractFace(faceId, otherCps);
    faces[faceId] = out;
    missingByFace[faceId] = missing;
  }
  {
    // The CJK face is also allowed to cover non-routed codepoints it supports
    // (e.g. kana); its primary pool is still the CJK-routed set.
    const primary = extractFace('cjk-regular', cjkCps);
    const extra = extractFace('cjk-regular', otherCps);
    faces['cjk-regular'] = { ...extra.out, ...primary.out };
    missingByFace['cjk-regular'] = [...new Set([...primary.missing, ...extra.missing])];
  }
  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    generator: 'tools/build-dynamic-sources.mjs',
    settings,
    languagePresets: LANGUAGE_PRESETS,
    faces,
    missingByFace: Object.fromEntries(Object.entries(missingByFace).map(([k, v]) => [k, v.map((cp) => 'U+' + cp.toString(16).toUpperCase())])),
  };
}

function main() {
  const outDir = path.join(ROOT, 'web', 'atlas');
  fs.mkdirSync(outDir, { recursive: true });
  const payload = buildDynamicSources();
  const file = path.join(outDir, 'dynamic-sources.json');
  fs.writeFileSync(file, JSON.stringify(payload));
  const counts = Object.fromEntries(Object.entries(payload.faces).map(([id, f]) => [id, Object.keys(f).length]));
  const missing = Object.entries(payload.missingByFace).filter(([, v]) => v.length);
  console.log(`dynamic sources -> ${file}`);
  console.log(`glyphs per face: ${JSON.stringify(counts)}`);
  if (missing.length) {
    for (const [id, v] of missing) console.log(`placeholder pool ${id}: ${v.join(' ')}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
