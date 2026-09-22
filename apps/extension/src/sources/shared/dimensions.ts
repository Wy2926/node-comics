// CSS pixels, not source resolution: exclude avatars, thumbnails and thin banners.
export function comicSize(width: number, height: number) {
  return (
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width >= 240 &&
    height >= 180 &&
    width * height >= 100000 &&
    width / height <= 2.8
  );
}
