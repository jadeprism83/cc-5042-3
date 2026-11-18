// Builds the interface webfont from the vendored Noto Sans SC variable font.
//
// The UI chrome (labels, notices, audit copy) must be readable on machines with
// no CJK system font. The SDF atlas is for the rendered exhibit text; this
// subset is only for HTML chrome, so it includes exactly the characters that
// appear in web/ and nothing else. Run after editing UI strings:
//
//   node tools/build-ui-font.mjs
//
// Output: web/fonts/NotoSansSC-UI.ttf (OFL, see assets/fonts/NotoSansSC-OFL.txt).
//
// Subsetting/instancing is done by tools/subset-ui-font.py. fontkit's own
// subsetter drops cmap and emits misaligned tables (browsers reject the file),
// so it is not used here. If python3 + fontTools are unavailable the script
// leaves an existing built font in place and reports it, rather than deleting a
// working artifact.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fontkit = require('fontkit');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'assets/fonts/NotoSansSC-VF.ttf');
const outDir = path.join(root, 'web/fonts');
const outPath = path.join(outDir, 'NotoSansSC-UI.ttf');

function collectText(dir) {
  const parts = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'fonts' || entry.name === 'atlas') continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) parts.push(collectText(p));
    else if (/\.(html|js|css|mjs)$/.test(entry.name)) parts.push(fs.readFileSync(p, 'utf8'));
  }
  return parts.join('\n');
}

// ASCII is always included: punctuation and digits show up in generated
// labels, and keeping it in the subset keeps the UI on one font.
const ascii = Array.from({ length: 95 }, (_, i) => i + 32);
// Shared modules produce error messages that the UI shows verbatim (e.g. the
// kernel's PAD_BREACH text), so their Chinese must be in the chrome subset too.
const text = collectText(path.join(root, 'web')) + '\n' + collectText(path.join(root, 'shared'));
const cps = new Set(ascii);
for (const ch of text) cps.add(ch.codePointAt(0));

const source = fontkit.create(fs.readFileSync(sourcePath));
// Only codepoints the source actually covers; anything else would fall back.
const wanted = [...cps].filter((cp) => {
  try { return cp < 0x20 || source.hasGlyphForCodePoint(cp); } catch { return false; }
});

fs.mkdirSync(outDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pavilion-ui-font-'));
const cpsFile = path.join(tmp, 'codepoints.txt');
fs.writeFileSync(cpsFile, wanted.map((cp) => String.fromCodePoint(cp)).join(''));

const res = spawnSync('python3', [path.join(root, 'tools/subset-ui-font.py'), sourcePath, outPath, cpsFile], {
  stdio: 'inherit',
  env: { ...process.env },
});
fs.rmSync(tmp, { recursive: true, force: true });

if (res.status !== 0) {
  if (fs.existsSync(outPath)) {
    console.warn('[ui-font] subsetter unavailable; keeping existing web/fonts/NotoSansSC-UI.ttf');
    process.exit(0);
  }
  console.error('[ui-font] failed to build the UI webfont. Install fontTools: python3 -m pip install fonttools');
  process.exit(res.status ?? 1);
}

const bytes = fs.statSync(outPath).size;
console.log(`[ui-font] ${wanted.length} codepoints -> ${path.relative(root, outPath)} (${(bytes / 1024).toFixed(1)} KiB)`);
