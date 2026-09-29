# Normalization fixtures

Synthetic 3 × 2 pixel images generated with Pillow 12.0.0; no external artwork.

- `orientation-6.jpg`: six RGB colors and EXIF orientation 6.
- `srgb-icc.png`: the same colors with an embedded Pillow ImageCms sRGB profile.
- `animated.png`, `animated.webp`, `animated.gif`: red first frame, blue second frame, 100 ms duration.

`verify_translation_overlay.mjs` checks native browser EXIF handling, metadata removal, exact upload digest and static first-frame output.
