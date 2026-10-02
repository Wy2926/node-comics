/** Client preflight defaults; authoritative image admission belongs to the center. */
export const TRANSLATION_SHORT_EDGE = 1800;
export const TRANSLATION_MAX_DIMENSION = 100_000;
// No independent area ceiling; retain the numeric capability default for existing clients.
export const TRANSLATION_MAX_PIXELS = TRANSLATION_MAX_DIMENSION ** 2;
export const TRANSLATION_MAX_BYTES = 128 * 1024 * 1024;
export const TRANSLATION_WEBP_QUALITY = 0.9;
export const TRANSLATION_REENCODE_BYTES = 1024 * 1024;
export const INPUT_PROFILE = 'short-edge-1800-webp90-v1' as const;
export function translationSize(width:number,height:number) {
  const scale=Math.min(1,TRANSLATION_SHORT_EDGE/Math.min(width,height));
  return {width:Math.max(1,Math.round(width*scale)),height:Math.max(1,Math.round(height*scale))};
}
