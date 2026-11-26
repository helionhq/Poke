"""Converts the Doop canvas's WOFF2 fonts (fonts/src) into files iOS loads (fonts/*.otf, *.ttf).

Run from packages/ui-tokens: python scripts/convert-fonts.py
Needs fontTools and brotli (pip install fonttools brotli).
Exposure VAR is a variable font with one axis, EXPO (expressiveness, not weight). React Native
can't set axes, so a static instance is cut at the canvas's default (EXPO 0), which is what every
frame renders.
"""

from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "fonts" / "src"
OUT = ROOT / "fonts"


def plain(name: str) -> None:
    font = TTFont(SRC / f"{name}.woff2")
    font.flavor = None
    ext = ".otf" if "CFF " in font else ".ttf"
    font.save(OUT / f"{name}{ext}")
    print("wrote", name + ext)


def rename(font: TTFont, family: str, style: str) -> None:
    """Gives an instance its own PostScript name so iOS registers each weight separately."""
    names = font["name"]
    postscript = f"{family.replace(' ', '')}-{style}"
    for record in list(names.names):
        if record.nameID in (1, 16):
            record.string = family
        elif record.nameID in (2, 17):
            record.string = style
        elif record.nameID == 4:
            record.string = f"{family} {style}"
        elif record.nameID == 6:
            record.string = postscript


def exposure() -> None:
    base = TTFont(SRC / "ExposureVAR.woff2")
    base.flavor = None
    axes = {a.axisTag: (a.minValue, a.defaultValue, a.maxValue) for a in base["fvar"].axes}
    print("Exposure axes", axes)
    font = TTFont(SRC / "ExposureVAR.woff2")
    font.flavor = None
    static = instancer.instantiateVariableFont(font, {tag: default for tag, (_, default, _) in axes.items()})
    rename(static, "Exposure", "Regular")
    static.save(OUT / "Exposure-Regular.ttf")
    print("wrote Exposure-Regular.ttf")


for name in ("OpenRunde-Regular", "OpenRunde-Medium", "OpenRunde-Semibold", "OpenRunde-Bold"):
    plain(name)
exposure()
