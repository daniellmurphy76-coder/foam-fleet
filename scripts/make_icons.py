#!/usr/bin/env python3
"""Draws the Foam Fleet home-screen icons into public/icons/.

Run from the project root:  python scripts/make_icons.py
Needs Python 3 + Pillow (no npm dependencies). The PNGs are committed, CI does not run this.

The art matches public/favicon.svg: turquoise water, a red toy speedboat with a white cabin and an
orange-and-blue foam blaster, and a white wave line. Everything is drawn at 4x size and shrunk with
LANCZOS, so the edges stay smooth.

Two looks:
  disc  - a water disc on a transparent square (icon-192, icon-512), like the favicon.
  bleed - water fills the whole square (icon-180, icon-512-maskable). iOS paints transparent corners
          black and rounds the square itself; Android masks a maskable icon to a circle that is 80%
          of the width, so the boat is scaled down until it sits well inside that circle.
"""
from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps

SS = 4  # supersampling factor
OUT = Path(__file__).resolve().parent.parent / 'public' / 'icons'

# Palette: the favicon's colors plus the game's UI navy for outlines.
WATER_TOP = (67, 200, 232)
WATER_MID = (24, 160, 200)  # #18a0c8, the favicon water
WATER_LOW = (15, 127, 168)
NAVY = (11, 42, 91)
HULL = (255, 69, 51)
HULL_DARK = (201, 48, 31)
WHITE = (255, 255, 255)
WINDOW = (47, 143, 224)
BLUE = (47, 111, 224)
ORANGE = (255, 162, 31)

OUTLINE = 1.5  # outline thickness, in design units (the art is designed on a 64 x 64 grid)
CENTER = (32.0, 34.0)  # where the boat sits, in design units


class Art:
    """One icon being drawn: a supersampled RGBA image plus design-unit -> pixel helpers."""

    def __init__(self, size: int, fill_square: bool, boat_scale: float) -> None:
        self.size = size
        self.n = size * SS
        self.u = self.n / 64  # pixels per design unit
        self.k = boat_scale
        self.fill_square = fill_square
        self.img = Image.new('RGBA', (self.n, self.n), (0, 0, 0, 0))

    def pt(self, x: float, y: float) -> tuple[float, float]:
        """Design units -> pixels, with the boat scaled about its center."""
        cx, cy = CENTER
        return ((cx + (x - cx) * self.k) * self.u, (cy + (y - cy) * self.k) * self.u)

    def px(self, v: float) -> float:
        return v * self.k * self.u

    def blank(self) -> Image.Image:
        return Image.new('L', (self.n, self.n), 0)

    def rrect(self, x0: float, y0: float, x1: float, y1: float, r: float) -> Image.Image:
        m = self.blank()
        ImageDraw.Draw(m).rounded_rectangle([*self.pt(x0, y0), *self.pt(x1, y1)], radius=self.px(r), fill=255)
        return m

    def poly(self, pts: list[tuple[float, float]], round_px: float = 0.0) -> Image.Image:
        m = self.blank()
        ImageDraw.Draw(m).polygon([self.pt(x, y) for x, y in pts], fill=255)
        return soften(m, self.px(round_px)) if round_px else m

    def paint(self, mask: Image.Image, color: tuple[int, ...], alpha: int = 255) -> None:
        layer = Image.new('RGBA', self.img.size, color[:3] + (255,))
        layer.putalpha(mask if alpha == 255 else mask.point(lambda v: v * alpha // 255))
        self.img.alpha_composite(layer)

    def part(self, mask: Image.Image, color: tuple[int, ...]) -> Image.Image:
        """A navy-outlined chunk of the boat, like the game's chunky UI. Returns its mask."""
        self.paint(grow(mask, self.px(OUTLINE)), NAVY)
        self.paint(mask, color)
        return mask

    def wave(self, y0: float, amp: float, width: float, alpha: int) -> None:
        """A white wave line from one side of the icon to the other (clipped to the water later)."""
        pts = []
        for i in range(-40, 105):
            x = float(i)
            pts.append(self.pt(x, y0 + amp * math.sin((x - 6.0) * 2 * math.pi / 20.0)))
        m = self.blank()
        ImageDraw.Draw(m).line(pts, fill=255, width=max(1, round(self.px(width))), joint='curve')
        self.paint(m, WHITE, alpha)

    def glint(self, x: float, y: float, r: float) -> None:
        m = self.blank()
        cx, cy = self.pt(x, y)
        rp = self.px(r)
        ImageDraw.Draw(m).ellipse([cx - rp, cy - rp, cx + rp, cy + rp], fill=255)
        self.paint(m, WHITE, 120)


def soften(mask: Image.Image, px: float) -> Image.Image:
    """Round off sharp corners."""
    return mask.filter(ImageFilter.GaussianBlur(px)).point(lambda v: 255 if v >= 128 else 0)


def grow(mask: Image.Image, px: float) -> Image.Image:
    """Grow a mask outward by about `px` pixels with rounded corners (for outlines)."""
    return mask.filter(ImageFilter.GaussianBlur(px * 0.7)).point(lambda v: 255 if v > 20 else 0)


def water(art: Art) -> Image.Image:
    """The water background and the mask that everything gets clipped to."""
    ramp = Image.linear_gradient('L').resize((art.n, art.n))
    fill = ImageOps.colorize(ramp, black=WATER_TOP, white=WATER_LOW, mid=WATER_MID)
    shape = art.blank()
    if art.fill_square:
        shape.paste(255, [0, 0, art.n, art.n])
    else:
        u = art.u  # the favicon's disc: center (32, 32), radius 30 (the boat scale does not apply)
        ImageDraw.Draw(shape).ellipse([2 * u, 2 * u, 62 * u, 62 * u], fill=255)
    art.img.paste(fill, mask=shape)
    return shape


def draw_boat(art: Art) -> None:
    # Hull: wide at the deck, narrow at the keel, with a white trim stripe and a darker underside.
    hull = art.part(art.poly([(9, 35), (56, 35), (49, 48), (17, 48)], round_px=1.2), HULL)
    art.paint(ImageChops.multiply(hull, art.rrect(0, 35, 64, 38.2, 0)), WHITE)
    art.paint(ImageChops.multiply(hull, art.rrect(0, 45.2, 64, 49, 0)), HULL_DARK)
    # Cabin with a window.
    art.part(art.rrect(20, 22, 34, 35.5, 2.6), WHITE)
    art.paint(art.rrect(23, 25, 31, 30, 1.6), WINDOW)
    # Foam blaster: blue body, orange barrel.
    art.part(art.rrect(45, 25.2, 57.5, 30.2, 2.2), ORANGE)
    art.part(art.rrect(32.5, 23.5, 46.5, 31.5, 2.6), BLUE)


def draw_scene(art: Art) -> None:
    clip = water(art)
    for x, y, r in ((17, 15, 1.5), (47, 11, 1.1), (54, 20, 0.9)):
        art.glint(x, y, r)
    draw_boat(art)
    art.wave(48.8, 1.9, 3.2, 255)  # the wave line the boat sits in
    art.wave(57.0, 1.6, 2.2, 150)  # a fainter one below
    # Clip waves and everything else to the water shape (the disc look has transparent corners).
    art.img.putalpha(ImageChops.multiply(art.img.getchannel('A'), clip))


def make(name: str, size: int, fill_square: bool, boat_scale: float = 1.0, opaque: bool = False) -> None:
    art = Art(size, fill_square, boat_scale)
    draw_scene(art)
    out = art.img.resize((size, size), Image.LANCZOS)
    if opaque:
        out = out.convert('RGB')  # no alpha channel at all, so iOS cannot paint anything black
    OUT.mkdir(parents=True, exist_ok=True)
    out.save(OUT / name, optimize=True)
    print(f'wrote public/icons/{name} ({size}x{size})')


def main() -> None:
    make('icon-180.png', 180, fill_square=True, boat_scale=0.95, opaque=True)
    make('icon-192.png', 192, fill_square=False)
    make('icon-512.png', 512, fill_square=False)
    # Maskable: everything that matters stays inside the central 80% circle.
    make('icon-512-maskable.png', 512, fill_square=True, boat_scale=0.86, opaque=True)


if __name__ == '__main__':
    main()
