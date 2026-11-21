const stages=['load','preload','detect','bubble','ocr','merge','order','ocr_postfilter','llm_ocr_filter','translate','mask_refine','inpaint','parallel','typeset'];
const knownCodes=new Set([
  ...stages.map(stage=>'PIPELINE_'+stage.toUpperCase()),
  'TEXT_GOOGLE_UNAVAILABLE','TEXT_HTTP','TEXT_AUTH','TEXT_RATE_LIMIT','TEXT_CONFIG_INVALID','TEXT_CONFIG_CHANGED',
  'TEXT_LANGUAGE_UNSUPPORTED','TEXT_THINKING_INVALID','TEXT_THINKING_BUDGET','TEXT_THINKING_REQUIRED',
  'TEXT_INPUT_INVALID','TEXT_OUTPUT_INVALID','TEXT_OUTPUT_LIMIT','TEXT_CHECKPOINT_MISMATCH','TEXT_OUTCOME_UNKNOWN','TEXT_STORAGE_FULL',
  'ASSET_MISSING','ASSET_CORRUPT','FONT_UNAVAILABLE','SOURCE_MISSING','SOURCE_CHANGED','RESULT_NOT_CACHED',
  'LOCAL_HOST_EXTENSION_REQUIRED','LOCAL_HOST_UNAVAILABLE','LOCAL_BUSY','INTERRUPTED',
]);
export function knownLocalCode(code:unknown){
  return typeof code==='string'&&(knownCodes.has(code)||/^TEXT_(?:HTTP_[45]\d\d|GOOGLE_HTTP_(?:401|403))$/.test(code))?code:'PIPELINE_FAILED';
}

/** Pipeline exceptions may carry OCR text or artifacts; only owned codes cross the worker/storage boundary. */
export function localFailureCode(error:unknown){
  if(error instanceof Error&&error.name==='QuotaExceededError')return 'TEXT_STORAGE_FULL';
  const stage=error&&typeof error==='object'&&'failure' in error?(error.failure as {stage?:unknown}|null)?.stage:undefined;
  if(typeof stage==='string'&&stages.includes(stage))return 'PIPELINE_'+stage.toUpperCase();
  return knownLocalCode(error instanceof Error?error.message:undefined);
}
