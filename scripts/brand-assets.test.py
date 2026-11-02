"""Pixel/provenance acceptance, without an APK or a web build."""
import importlib.util
from pathlib import Path
import unittest
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('brand', ROOT / 'scripts/generate-brand-assets.py')
brand = importlib.util.module_from_spec(spec)
if spec.loader:
    spec.loader.exec_module(brand)


class BrandAssets(unittest.TestCase):
    def test_reproducible_all_outputs(self):
        outputs = brand.generate()
        manifest_path = 'apps/mobile/src/assets/brand/generated-brand-manifest.json'
        self.assertIn(manifest_path, outputs)
        for path, expected in outputs.items():
            self.assertEqual((ROOT / path).read_bytes(), expected, path)

    def test_master_and_prepared_tiles_preserved(self):
        self.assertEqual(brand.sha((ROOT / brand.MASTER).read_bytes()), brand.MASTER_SHA)
        for name, digest in {
            'brand-tile-dark.png': 'b9ec78609b98a3697732d2dff43dea1fb899c51b8693df5659f489f4e60073b4',
            'brand-tile-light.png': '17a5370d16875e589c52317f95457ae1b39ee81c55717adcc481ebc62624af79',
        }.items():
            self.assertEqual(brand.sha((ROOT / brand.BRAND / name).read_bytes()), digest)

    def test_notification_alpha_not_bell_or_tile(self):
        for density, scale in brand.DENSITIES.items():
            path = ROOT / brand.RES / f'drawable-{density}/ic_stat_findback.png'
            im = Image.open(path).convert('RGBA')
            self.assertEqual(im.size, (int(24 * scale),) * 2)
            self.assertEqual(im.getpixel((0, 0))[3], 0)
            self.assertTrue(all((r, g, b) == (255, 255, 255) for r, g, b, a in im.getdata() if a))
            self.assertLess(sum(p[3] > 127 for p in im.getdata()), im.width * im.height * .7)
        self.assertFalse((ROOT / brand.RES / 'drawable/ic_stat_findback.xml').exists())

    def test_adaptive_safe_zone_and_holes(self):
        for density, scale in brand.DENSITIES.items():
            im = Image.open(ROOT / brand.RES / f'mipmap-{density}/ic_launcher_foreground.png')
            a = im.getchannel('A')
            box = a.point(lambda v: 255 if v > 20 else 0).getbbox()
            self.assertGreaterEqual(box[0], int(21 * scale) - 1)
            self.assertLessEqual(box[2], int(87 * scale) + 1)
            # A point inside the bird's head is a hole, not a filled tile.
            self.assertLess(im.getpixel((round(im.width * .61), round(im.height * .45)))[3], 25)


if __name__ == '__main__':
    unittest.main()
