# Basic Ghost Labs - Good Boy. Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
# The old Good Boy mascot, refreshed: a blue-to-cyan gradient instead of flat blue, soft shading on the fur,
# a pink heart, and a light glow. The drawing itself is unchanged.
# Run from anywhere: python3 v4/launcher/brand/refresh.py  (writes the launcher's logo and the app icons too)
from PIL import Image, ImageFilter, ImageDraw
import numpy as np, os
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..', '..'))
src = Image.open(os.path.join(ROOT, 'desktop', 'renderer', 'brand', 'app-icon.png')).convert('RGBA')
a = np.asarray(src).astype(float) / 255
rgb, alpha = a[..., :3], a[..., 3]
h, w = alpha.shape
# how "blue" each pixel is: white has full red, the blue ink has none
ink = np.clip(1 - rgb[..., 0], 0, 1)
yy, xx = np.mgrid[0:h, 0:w] / max(h, w)
t = np.clip((xx * 0.55 + yy * 0.75 - 0.25) / 0.95, 0, 1)[..., None]
top, bottom = np.array([0.35, 0.47, 1.0]), np.array([0.05, 0.78, 0.98])
grad = top * (1 - t) + bottom * t
deep = np.array([0.12, 0.2, 0.75])
# the outline gets a deeper edge where the ink is darkest
ink_col = grad * 0.85 + deep * 0.15
# fur: white with a gentle cool shadow towards the bottom
fur = np.ones(3) * (1 - 0.10 * yy[..., None]) + np.array([-0.05, -0.02, 0.0]) * yy[..., None]
out = fur * (1 - ink[..., None]) + ink_col * ink[..., None]
# the heart in the headphone, in pink
cy, cx, r = 433, 657, 31
mask = ((yy * max(h, w) - cy) ** 2 + (xx * max(h, w) - cx) ** 2 < r * r) & (ink < 0.5) & (alpha > 0.3)
out[mask] = np.array([1.0, 0.43, 0.68])
# a soft shine across the top of the visor
shine = Image.new('L', (w, h), 0)
ImageDraw.Draw(shine).ellipse((390, 400, 600, 520), fill=255)
shine = np.asarray(shine.filter(ImageFilter.GaussianBlur(40))).astype(float) / 255
visor = np.zeros((h, w)); visor[380:720, 330:640] = 1
amount = (shine * visor * (ink > 0.6))[..., None] * 0.22
out = out * (1 - amount) + np.ones(3) * amount
img = Image.fromarray((np.dstack([np.clip(out, 0, 1), alpha]) * 255).astype('uint8'), 'RGBA')
# a soft glow behind it
glow = Image.new('RGBA', img.size, (0, 0, 0, 0))
g_alpha = img.split()[3].filter(ImageFilter.GaussianBlur(28)).point(lambda v: int(v * 0.55))
glow.paste(Image.new('RGBA', img.size, (60, 170, 255, 255)), (0, 0), g_alpha)
final = Image.alpha_composite(glow, img)
final.save(os.path.join(HERE, 'mascot.png'))
final.resize((512, 512), Image.LANCZOS).save(os.path.join(HERE, '..', 'ui', 'mascot.png'))
icons = os.path.join(ROOT, 'v4', 'crates', 'gb-launcher', 'icons')
final.resize((512, 512), Image.LANCZOS).save(os.path.join(icons, 'icon.png'))
sizes = [16, 24, 32, 48, 64, 128, 256]
frames = [final.resize((n, n), Image.LANCZOS) for n in sizes]
frames[-1].save(os.path.join(icons, 'icon.ico'), format='ICO', sizes=[(n, n) for n in sizes], append_images=frames[:-1])
