#!/usr/bin/env python3
"""Deterministic current Norfold derivatives. No tracing or invented geometry.

The Oct19 owner master supersedes the historical Oct09 logo2-master.jpg.
Tile keying is promoted verbatim in algorithm from the private home-chrome
derive-brand-tile.py: threshold, close/fill footprint, crop, pad, Lanczos.
Only monochrome surfaces key the white interior to alpha (not a second tile).
Requires Pillow 11.1.0; --check never writes. See BRANDING.md.
"""
from collections import deque
import hashlib
import io
import json
from pathlib import Path
import sys
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
BRAND = 'apps/mobile/src/assets/brand'
RES = 'apps/mobile/android/app/src/main/res'
MASTER = f'{BRAND}/brand-tile-master.png'
MASTER_SHA = '27c4f0479e5240b549183731d4302633c31734a405d1bdf2cc154543ebcc0b4d'
DENSITIES = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}
TOKEN = 'birdleaf-v1'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def square(im, size):
    side = max(im.size)
    canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    canvas.paste(im, ((side - im.width) // 2, (side - im.height) // 2))
    return canvas.resize((size, size), Image.Resampling.LANCZOS)


def prepared():
    data = (ROOT / MASTER).read_bytes()
    if sha(data) != MASTER_SHA:
        raise ValueError('Owner master hash changed; review provenance before regenerating')
    master = Image.open(io.BytesIO(data)).convert('RGB')
    ink = master.convert('L').point(lambda v: 255 if v < 128 else 0)
    closed = ink.filter(ImageFilter.MaxFilter(7))
    w, h = closed.size
    px = closed.load()
    outside = bytearray(w * h)
    queue = deque()

    def push(x, y):
        if 0 <= x < w and 0 <= y < h and not outside[y * w + x] and px[x, y] == 0:
            outside[y * w + x] = 1
            queue.append((x, y))

    for x in range(w):
        push(x, 0)
        push(x, h - 1)
    for y in range(h):
        push(0, y)
        push(w - 1, y)
    while queue:
        x, y = queue.popleft()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            push(x + dx, y + dy)
    footprint = Image.new('L', (w, h), 0)
    footprint.putdata([255 if px[x, y] or not outside[y * w + x] else 0
                       for y in range(h) for x in range(w)])
    box = footprint.getbbox()
    assert box and footprint.getpixel((w // 2, h // 2)) == 255
    assert footprint.getpixel((3, 3)) == 0
    crop = (box[0], box[1], box[2] + 1, box[3] + 1)
    fp, ink = footprint.crop(crop), ink.crop(crop)
    tiles = {}
    for variant, body, hole in [('dark', (10, 10, 10), (255, 255, 255)),
                                ('light', (255, 255, 255), (10, 10, 10))]:
        tile = Image.new('RGBA', fp.size, (0, 0, 0, 0))
        tile.putdata([(body if i else hole) + (255,) if f else (0, 0, 0, 0)
                      for f, i in zip(fp.getdata(), ink.getdata())])
        tiles[variant] = square(tile, 512)
    # Source ink, not the filled footprint: the bird/leaf remains transparent.
    glyph = Image.new('RGBA', ink.size, (255, 255, 255, 0))
    glyph.putalpha(ink)
    return tiles, square(glyph, 512)


def generate():
    outputs, records = {}, {}

    def save(path, im, recipe, fmt='PNG', **options):
        buf = io.BytesIO()
        im.save(buf, format=fmt, **options)
        outputs[path] = buf.getvalue()
        records[path] = {'sha256': sha(outputs[path]), 'width': im.width,
                         'height': im.height, 'recipe': recipe}

    tiles, white = prepared()
    black = Image.new('RGBA', white.size, (0, 0, 0, 0))
    black.putalpha(white.getchannel('A'))
    for variant in ('dark', 'light'):
        save(f'{BRAND}/brand-tile-{variant}.png', tiles[variant], 'historical exact tile keying')
        save(f'{BRAND}/brand-mark-{variant}.png', black if variant == 'dark' else white,
             'owner ink to monochrome alpha')

    def inset(im, size, art_size, background=(0, 0, 0, 0)):
        canvas = Image.new('RGBA', (size, size), background)
        art = im.resize((art_size, art_size), Image.Resampling.LANCZOS)
        canvas.alpha_composite(art, ((size - art_size) // 2,) * 2)
        return canvas

    for size in (16, 32, 48, 180, 192, 512):
        # Opaque neutral tile field remains legible in light/dark browser chrome.
        im = inset(white, size, max(1, round(size * .84)), (26, 26, 26, 255))
        name = f'findback-{TOKEN}-{size}.png'
        save(f'apps/mobile/public/icons/{name}', im, 'white ink, 84% on #1a1a1a')
        if size in (180, 192, 512):
            old = 'apple-touch-icon.png' if size == 180 else f'findback-{size}.png'
            save(f'apps/mobile/public/icons/{old}', im, 'current compatibility URL')
    ico = inset(white, 48, 40, (26, 26, 26, 255))
    save('apps/mobile/public/favicon.ico', ico, 'multi-size 16/32/48 current fallback',
         fmt='ICO', sizes=[(16, 16), (32, 32), (48, 48)])

    for density, scale in DENSITIES.items():
        legacy_size = int(48 * scale)
        legacy = inset(white, legacy_size, round(legacy_size * .75), (26, 26, 26, 255))
        for name in ('ic_launcher', 'ic_launcher_round'):
            save(f'{RES}/mipmap-{density}/{name}.png', legacy, 'legacy current mark')
        # An unmasked alpha emblem inside Android's 66dp safe zone. No tile.
        foreground = inset(white, int(108 * scale), int(64 * scale))
        save(f'{RES}/mipmap-{density}/ic_launcher_foreground.png', foreground, '64dp ink in 108dp safe zone')
        save(f'{RES}/drawable-{density}/ic_launcher_monochrome.png', foreground, 'same alpha as adaptive foreground')
        save(f'{RES}/drawable-{density}/ic_stat_findback.png',
             inset(white, int(24 * scale), int(22 * scale)), '22dp white ink in 24dp transparent canvas')
        # Unanimated Android 12+/compat splash, within the 192dp safe circle.
        save(f'{RES}/drawable-{density}/brand_splash_icon.png',
             inset(white, int(288 * scale), int(160 * scale)), '160dp white ink in 288dp splash canvas')

    splash_sizes = {'drawable': (480, 320),
                    'drawable-port-mdpi': (320, 480), 'drawable-port-hdpi': (480, 800),
                    'drawable-port-xhdpi': (720, 1280), 'drawable-port-xxhdpi': (960, 1600),
                    'drawable-port-xxxhdpi': (1280, 1920),
                    'drawable-land-mdpi': (480, 320), 'drawable-land-hdpi': (800, 480),
                    'drawable-land-xhdpi': (1280, 720), 'drawable-land-xxhdpi': (1600, 960),
                    'drawable-land-xxxhdpi': (1920, 1280)}
    for directory, size in splash_sizes.items():
        im = Image.new('RGBA', size, (26, 26, 26, 255))
        side = round(min(size) * .2)
        art = white.resize((side, side), Image.Resampling.LANCZOS)
        im.alpha_composite(art, ((size[0] - side) // 2, (size[1] - side) // 2))
        save(f'{RES}/{directory}/splash.png', im, 'centered owner ink, retained #1a1a1a background')

    manifest = {'generation': TOKEN, 'master': {'path': MASTER, 'sha256': MASTER_SHA},
                'generator': {'path': 'scripts/generate-brand-assets.py',
                              'sha256': sha(Path(__file__).read_bytes()), 'pillow': '11.1.0'},
                'historical_master': f'{BRAND}/logo2-master.jpg', 'outputs': records}
    outputs[f'{BRAND}/generated-brand-manifest.json'] = (json.dumps(manifest, indent=2) + '\n').encode()
    return outputs


if __name__ == '__main__':
    check = sys.argv[1:] == ['--check']
    if sys.argv[1:] not in ([], ['--check']):
        raise SystemExit('Usage: generate-brand-assets.py [--check]')
    outputs = generate()
    for path, content in outputs.items():
        target = ROOT / path
        if check:
            if not target.exists() or target.read_bytes() != content:
                raise SystemExit(f'Brand generation differs: {path}')
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
    print(f'Brand assets {"verified" if check else "generated"}: {len(outputs)} files')
