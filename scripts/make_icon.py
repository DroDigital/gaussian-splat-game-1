"""Procedurally draws build/icon.png (1024x1024): mono-yellow striped wallpaper,
a dark doorway, a glowing red EXIT sign, vignette and grain. Requires Pillow.

    python3 scripts/make_icon.py
"""
import math
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

S = 1024
rng = random.Random(7)
img = Image.new("RGB", (S, S))
px = img.load()
for y in range(S):
    for x in range(S):
        band = (x // 40) % 2
        base = (206, 184, 98) if band else (214, 192, 106)
        # light falloff from a ceiling panel above
        lum = 1.05 - 0.55 * (y / S) ** 1.3 - 0.25 * abs(x - S / 2) / S
        g = 0.97 + 0.06 * rng.random()
        px[x, y] = tuple(max(0, min(255, int(c * lum * g))) for c in base)

d = ImageDraw.Draw(img)
# carpet
d.rectangle([0, int(S * 0.8), S, S], fill=(92, 74, 34))
# doorway with a corridor receding into darkness
dw, dh = 300, 520
x0, y0 = (S - dw) // 2, int(S * 0.8) - dh
d.rectangle([x0 - 16, y0 - 16, x0 + dw + 16, y0 + dh], fill=(150, 128, 60))
for i in range(12):
    k = i / 12
    c = int(60 * (1 - k) ** 2)
    inset = int(k * 120)
    d.rectangle([x0 + inset, y0 + inset * 0.7, x0 + dw - inset, y0 + dh], fill=(c + 8, int(c * 0.85) + 6, int(c * 0.4) + 2))
# EXIT sign
sx0, sy0, sx1, sy1 = S // 2 - 170, y0 - 150, S // 2 + 170, y0 - 50
glow = Image.new("RGB", (S, S))
gd = ImageDraw.Draw(glow)
gd.rectangle([sx0 - 30, sy0 - 30, sx1 + 30, sy1 + 30], fill=(170, 20, 10))
glow = glow.filter(ImageFilter.GaussianBlur(40))
img = Image.blend(img, Image.composite(glow, img, glow.convert("L")), 0.6)
d = ImageDraw.Draw(img)
d.rectangle([sx0, sy0, sx1, sy1], fill=(22, 6, 4))
font = None
for name in ["DejaVuSans-Bold.ttf", "Arial Bold.ttf", "LiberationSans-Bold.ttf"]:
    try:
        font = ImageFont.truetype(name, 84)
        break
    except OSError:
        pass
if font is None:
    font = ImageFont.load_default()
tb = d.textbbox((0, 0), "EXIT", font=font)
tw, th = tb[2] - tb[0], tb[3] - tb[1]
d.text(((sx0 + sx1 - tw) // 2 - tb[0], (sy0 + sy1 - th) // 2 - tb[1]), "EXIT", font=font, fill=(255, 70, 50))
# vignette + rounded mask
vig = Image.new("L", (S, S))
vp = vig.load()
for y in range(S):
    for x in range(S):
        r = math.hypot(x - S / 2, y - S / 2) / (S * 0.72)
        vp[x, y] = int(255 * max(0.0, 1 - r**2.4))
img = Image.composite(img, Image.new("RGB", (S, S)), vig)
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=180, fill=255)
out = Image.new("RGBA", (S, S))
out.paste(img, (0, 0), mask)
dst = Path(__file__).resolve().parent.parent / "build" / "icon.png"
dst.parent.mkdir(exist_ok=True)
out.save(dst, optimize=True)
print("wrote", dst)
