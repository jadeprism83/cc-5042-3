#!/usr/bin/env python3
"""Subset web/fonts/NotoSansSC-UI.ttf from the vendored variable font.

Called by tools/build-ui-font.mjs. Requires fontTools (pip install fonttools, or
PYTHONPATH pointing at an unpacked wheel).

    python3 tools/subset-ui-font.py <source.ttf> <out.ttf> <codepoints.txt>

The source is a variable font whose default wght is 100. The UI is instantiated
at wght=400 first, because a subset of the extra-light master would render the
interface noticeably thin. Instancing also removes fvar/gvar, so the emitted
file is a plain static TrueType font that every browser can load.
"""
import sys

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont


def main() -> int:
    if len(sys.argv) != 4:
        print(__doc__, file=sys.stderr)
        return 2
    src, out, cps_path = sys.argv[1:]
    text = open(cps_path, encoding="utf-8").read()
    codepoints = sorted({ord(ch) for ch in text})

    font = TTFont(src)
    if "fvar" in font:
        font = instantiateVariableFont(font, {"wght": 400}, inplace=False, updateFontNames=True)

    opts = subset.Options()
    opts.layout_features = ["*"]
    opts.name_IDs = ["*"]
    opts.name_legacy = True
    opts.notdef_outline = True
    opts.recalc_bounds = True
    opts.recalc_timestamp = False
    opts.drop_tables += ["DSIG"]

    sub = subset.Subsetter(options=opts)
    sub.populate(unicodes=codepoints)
    sub.subset(font)
    subset.save_font(font, out, opts)

    check = TTFont(out)
    cmap = check.getBestCmap()
    missing = [cp for cp in codepoints if cp not in cmap and cp not in (0x0A, 0x0D, 0x09)]
    print(f"[ui-font] instanced wght=400, {len(cmap)} codepoints in cmap, {len(codepoints)} requested")
    if missing:
        print("[ui-font] missing from source: " + " ".join(f"U+{cp:04X}" for cp in missing))
    return 0


if __name__ == "__main__":
    sys.exit(main())
