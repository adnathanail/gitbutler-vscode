# Builds resources/gitbutler-icons.woff, the icon font behind `$(gitbutler-vscode-logo)` in status bar text.
# Status bar text can only show icons from fonts, so the bowtie from resources/gitbutler-*.svg is
# redrawn here as a glyph.
#
# Run with: uv run --with fonttools scripts/build-icon-font.py

from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

# Matches `fontCharacter` in package.json.
CODEPOINT = 0xE000
# The SVG's 16×16 grid, scaled by 10. Font coordinates have y pointing up.
EM = 160


def svg_point(x, y):
    return (round(x * 10), round((16 - y) * 10))


def bowtie():
    pen = TTGlyphPen(None)
    # From the SVG path "M1.5 2.5 8 8l-6.5 5.5zM14.5 2.5 8 8l6.5 5.5z", wound clockwise.
    for triangle in ([(1.5, 2.5), (8, 8), (1.5, 13.5)], [(14.5, 2.5), (14.5, 13.5), (8, 8)]):
        pen.moveTo(svg_point(*triangle[0]))
        for point in triangle[1:]:
            pen.lineTo(svg_point(*point))
        pen.closePath()
    return pen.glyph()


builder = FontBuilder(EM, isTTF=True)
builder.setupGlyphOrder([".notdef", "bowtie"])
builder.setupCharacterMap({CODEPOINT: "bowtie"})
builder.setupGlyf({".notdef": TTGlyphPen(None).glyph(), "bowtie": bowtie()})
builder.setupHorizontalMetrics({".notdef": (EM, 0), "bowtie": (EM, 15)})
builder.setupHorizontalHeader(ascent=EM, descent=0)
builder.setupNameTable({"familyName": "GitButler Stacks Icons", "styleName": "Regular"})
builder.setupOS2(sTypoAscender=EM, sTypoDescender=0, usWinAscent=EM, usWinDescent=0)
builder.setupPost()
builder.font.flavor = "woff"
builder.save(Path(__file__).parent.parent / "resources" / "gitbutler-icons.woff")
