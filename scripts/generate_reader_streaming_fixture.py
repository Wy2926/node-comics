"""Generate deterministic, original comic-like images for the slow-network fixture (requires Pillow)."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import random
import sys

out = Path(sys.argv[1] if len(sys.argv) > 1 else 'artifacts/reader-streaming')
out.mkdir(parents=True, exist_ok=True)
rng = random.Random(42)
image = Image.new('RGB', (2400, 3600), '#fffaf0')
draw = ImageDraw.Draw(image)
font = ImageFont.load_default(size=60)
for row in range(4):
    for col in range(2):
        x, y = 80 + col * 1160, 80 + row * 880
        draw.rectangle((x, y, x + 1080, y + 800), fill=['#d6e8f6', '#eadfba', '#d7eac5', '#e3cce8'][row], outline='#242835', width=12)
        for _ in range(1200):
            a, b = rng.randint(x + 20, x + 1040), rng.randint(y + 30, y + 770)
            draw.line((a, b, a + rng.randint(-20, 20), b + rng.randint(-40, 40)), fill=(rng.randint(100, 220),) * 3, width=2)
        draw.ellipse((x + 300, y + 120, x + 780, y + 600), fill='#ffecd4', outline='#242835', width=16)
        for dx in (440, 620):
            draw.line((x + dx, y + 270, x + dx + 20, y + 320), fill='#242835', width=20)
        draw.arc((x + 430, y + 330, x + 650, y + 460), 0, 180, fill='#242835', width=14)
        draw.rounded_rectangle((x + 80, y + 630, x + 1000, y + 760), 20, fill='white', outline='#242835', width=8)
        draw.text((x + 120, y + 650), f'PANEL {row * 2 + col + 1} / SLOW LOAD', font=font, fill='#242835')
for name, options in [('progressive.jpg', dict(quality=92, progressive=True)), ('baseline.jpg', dict(quality=92)), ('plain.png', {}), ('plain.webp', dict(quality=92))]:
    path = out / name
    image.save(path, **options)
    print(f'{name}: {path.stat().st_size} bytes')
