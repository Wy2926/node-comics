import type { PlatformProvider, PipelineCanvas, PipelineRenderingContext } from "../runtime/platform";

/** Threshold an already quantized, opaque gray mask; retain source for fallback. */
export function tryNativeOpaqueMaskThreshold(
  source: PipelineCanvas,
  platform: PlatformProvider,
): PipelineCanvas | null {
  if ((globalThis as { __shinobuColdStartMaskNativeThreshold?: boolean }).__shinobuColdStartMaskNativeThreshold !== true) {
    return null;
  }
  type FilterContext = PipelineRenderingContext & {
    filter?: string;
    getContextAttributes?: () => { colorSpace?: string; colorType?: string };
  };
  const startedAt = performance.now();
  let target: PipelineCanvas | null = null;
  let succeeded = false;
  let status = 'unsupported';
  try {
    const sourceCtx = source.getContext('2d') as FilterContext | null;
    const sourceAttrs = sourceCtx?.getContextAttributes?.();
    if (sourceAttrs?.colorSpace !== 'srgb' || sourceAttrs.colorType !== 'unorm8') return null;

    target = platform.createCanvas(source.width, source.height);
    const settings: CanvasRenderingContext2DSettings & { colorType: 'unorm8' } = {
      willReadFrequently: (globalThis as {
        __shinobuColdStartMaskNativeThresholdGpu?: boolean;
      }).__shinobuColdStartMaskNativeThresholdGpu !== true,
      colorSpace: 'srgb', colorType: 'unorm8',
    };
    const ctx = target.getContext('2d', settings) as FilterContext | null;
    const attrs = ctx?.getContextAttributes?.();
    if (!ctx || typeof ctx.filter !== 'string'
      || attrs?.colorSpace !== 'srgb' || attrs.colorType !== 'unorm8') return null;

    ctx.save();
    try {
      // For every 8-bit v: 1000 * (v / 255 - 0.5) + 0.5 clips to
      // 0 at v <= 127 and 1 at v >= 128. Contrast leaves alpha unchanged.
      // Draw 1:1 from the existing 8-bit canvas, after the original interpolation.
      ctx.filter = 'contrast(100000%)';
      if (ctx.filter !== 'contrast(100000%)') return null;
      ctx.imageSmoothingEnabled = false;
      ctx.globalCompositeOperation = 'copy';
      ctx.drawImage(source, 0, 0);
    } finally {
      ctx.restore();
    }
    status = 'success';
    succeeded = true;
    return target;
  } catch {
    status = 'failed';
    return null;
  } finally {
    try {
      (globalThis as {
        __shinobuColdStartInitMark?: (record: Record<string, unknown>) => void;
      }).__shinobuColdStartInitMark?.({
        phase: 'mask.native-threshold', startedAt, durationMs: performance.now() - startedAt,
        width: source.width, height: source.height, status,
      });
    } catch { /* Optional diagnostic observer. */ }
    if (!succeeded && target) {
      try { target.dispose?.(); target.width = 0; target.height = 0; } catch { /* Release failed target. */ }
    }
  }
}
