import type { TextRegion } from "../../types";
import type { PlatformProvider, PipelineImage } from "../../runtime/platform";
import { detectByOnnx, type DetectOutput } from "./onnxDetect";
import { detectByHeuristic } from './heuristicOnly';
import { toErrorMessage } from '../../errorMessage';
import type { ModelRuntime } from '../../../../model-runtime/src/index';

export type { DetectOutput };

export type DetectionFallbackStrategy =
  | { kind: 'strict' }
  | { kind: 'heuristic-only' }
  | {
      kind: 'tesseract-then-heuristic';
      detectWithTesseract(
        image: PipelineImage,
        platform: PlatformProvider,
      ): Promise<TextRegion[]>;
    };

export async function detectTextRegionsWithMask(
  image: PipelineImage,
  platform: PlatformProvider,
  modelRuntime: ModelRuntime,
  fallbackStrategy: DetectionFallbackStrategy,
  onSubmitted?: () => void,
): Promise<DetectOutput> {
  const fallbackReasons: string[] = [];
  try {
    const onnxResult = await detectByOnnx(image, platform, modelRuntime, onSubmitted);
    return { ...onnxResult, engine: "onnx" };
  } catch (error) {
    if (fallbackStrategy.kind === 'strict') throw error;
    const reason = toErrorMessage(error); void reason;
    fallbackReasons.push(`onnx: ${reason}`);
    void 0;
  }

  if (fallbackStrategy.kind === 'tesseract-then-heuristic') {
    try {
      const tessRegions = await fallbackStrategy.detectWithTesseract(image, platform);
      if (tessRegions.length > 0) {
        return {
          regions: tessRegions,
          rawMaskCanvas: null,
          engine: "tesseract",
          fallbackReason: fallbackReasons.join(" | ")
        };
      }
    } catch (error) {
      const reason = toErrorMessage(error); void reason;
      fallbackReasons.push(`tesseract: ${reason}`);
      void 0;
    }
  }

  const heuristicRegions = await detectByHeuristic(image, platform);
  return {
    regions: heuristicRegions,
    rawMaskCanvas: null,
    engine: "heuristic",
    fallbackReason: fallbackReasons.join(" | ")
  };
}

export async function detectTextRegions(
  image: PipelineImage,
  platform: PlatformProvider,
  modelRuntime: ModelRuntime,
  fallbackStrategy: DetectionFallbackStrategy,
): Promise<TextRegion[]> {
  const result = await detectTextRegionsWithMask(
    image,
    platform,
    modelRuntime,
    fallbackStrategy,
  );
  return result.regions;
}
