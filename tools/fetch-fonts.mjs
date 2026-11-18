#!/usr/bin/env node
// Verifies the vendored distributable fonts and rebuilds derived font assets.
//
// The font binaries are committed under assets/fonts so the atlas can be built
// with no network access. This script does not download anything; it checks
// that every face named in shared/fontface.mjs is present, that the licences
// are present, and that the recorded SHA-256 values still match. Pass --check
// to skip rebuilding the UI subset.
//
//   node tools/fetch-fonts.mjs           # verify + rebuild web/fonts subset
//   node tools/fetch-fonts.mjs --check   # verify only (used by npm test)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FACES } from '../shared/fontface.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'assets', 'fonts');

// Recorded at vendoring time so a corrupted or swapped font is caught here
// rather than producing a silently different atlas.
const EXPECTED_SHA256 = {
  'DejaVuSans.ttf': '7da195a74c55bef988d0d48f9508bd5d849425c1770dba5d7bfc6ce9ed848954',
  'DejaVuSans-Bold.ttf': 'e6476c1b80502924294eed40894c5b18e06c181444ca953e5334262df9c27724',
  'DejaVuSans-ExtraLight.ttf': '6cb0746a1f68d176bebe83752cee35ebdf726cb1a1e88a01fc038ddf76de9ea8',
  'NotoSansSC-VF.ttf': 'a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da',
};
const REQUIRED_LICENSES = ['DejaVu-LICENSE.txt', 'NotoSansSC-OFL.txt'];

function sha256(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

let failed = false;
const files = new Set(Object.values(FACES).map((f) => f.file));
for (const file of files) {
  const p = path.join(dir, file);
  if (!fs.existsSync(p)) {
    console.error(`[fonts] MISSING ${file} (face declared in shared/fontface.mjs)`);
    failed = true;
    continue;
  }
  const hash = sha256(p);
  const expected = EXPECTED_SHA256[file];
  const size = (fs.statSync(p).size / 1048576).toFixed(2);
  if (expected && expected !== hash) {
    console.error(`[fonts] HASH MISMATCH ${file}\n  expected ${expected}\n  actual   ${hash}`);
    failed = true;
  } else {
    console.log(`[fonts] ${file.padEnd(28)} ${size.padStart(6)} MB  sha256 ${hash.slice(0, 16)}…`);
  }
}
for (const lic of REQUIRED_LICENSES) {
  if (!fs.existsSync(path.join(dir, lic))) {
    console.error(`[fonts] MISSING licence ${lic}`);
    failed = true;
  }
}
if (failed) process.exit(1);

console.log(`[fonts] ${files.size} faces verified, licences present.`);
if (!process.argv.includes('--check')) {
  execFileSync(process.execPath, [path.join(root, 'tools/build-ui-font.mjs')], { stdio: 'inherit' });
}
