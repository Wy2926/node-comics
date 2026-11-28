export const stageModels={load:null,preload:null,detect:'detector',bubble:'bubble',ocr:'paddleocr_v6_medium_rec',merge:null,
  ocr_postfilter:'paddleocr_v6_medium_rec',order:null,mask_refine:null,inpaint:'inpaint',typeset:null,finalize:null} as const;
export type LocalStage=keyof typeof stageModels;
export type LocalModel=NonNullable<(typeof stageModels)[LocalStage]>;
export const isLocalStage=(stage:unknown):stage is LocalStage=>typeof stage==='string'&&Object.hasOwn(stageModels,stage);
const knownCodes=new Set([
  ...Object.keys(stageModels).flatMap(stage=>{const code='PIPELINE_'+stage.toUpperCase();return [code,code+'_TIMEOUT'];}),
  'PIPELINE_LLM_OCR_FILTER','PIPELINE_TRANSLATE','PIPELINE_PARALLEL', // Older saved jobs.
  'TEXT_GOOGLE_UNAVAILABLE','TEXT_HTTP','TEXT_AUTH','TEXT_RATE_LIMIT','TEXT_CONFIG_INVALID','TEXT_CONFIG_CHANGED',
  'TEXT_LANGUAGE_UNSUPPORTED',
  // 历史任务仍可带这些诊断码；新请求不再按模型名产生此类错误。
  'TEXT_THINKING_INVALID','TEXT_THINKING_BUDGET','TEXT_THINKING_REQUIRED',
  'TEXT_INPUT_INVALID','TEXT_OUTPUT_INVALID','TEXT_OUTPUT_LIMIT','TEXT_CHECKPOINT_MISMATCH','TEXT_OUTCOME_UNKNOWN','TEXT_STORAGE_FULL',
  'TEXT_NETWORK','TEXT_MODEL_NOT_FOUND','TEXT_QUOTA','TEXT_PARAMETER_UNSUPPORTED','TEXT_OUTPUT_TRUNCATED',
  'ASSET_MISSING','ASSET_CORRUPT','FONT_UNAVAILABLE','SOURCE_MISSING','SOURCE_CHANGED','RESULT_NOT_CACHED',
  'LOCAL_HOST_EXTENSION_REQUIRED','LOCAL_HOST_UNAVAILABLE','LOCAL_BUSY','INTERRUPTED',
]);
export function knownLocalCode(code:unknown){
  return typeof code==='string'&&(knownCodes.has(code)||/^TEXT_(?:HTTP_[45]\d\d|GOOGLE_HTTP_(?:401|403))$/.test(code))?code:'PIPELINE_FAILED';
}

/** Pipeline exceptions may carry OCR text or artifacts; only owned codes cross the worker/storage boundary. */
export function localFailureCode(error:unknown){
  if(error instanceof Error&&error.name==='QuotaExceededError')return 'TEXT_STORAGE_FULL';
  return knownLocalCode(error instanceof Error?error.message:undefined);
}
