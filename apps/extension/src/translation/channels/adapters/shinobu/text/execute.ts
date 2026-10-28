import {readCheckpoint,saveCheckpoint,type LocalOperation,type TextCheckpoint} from '../operations';
import {translationInput,TextError,type TextRegion} from './protocol';
import {googleTranslate} from './google';
import {llmTranslate} from './openai-compatible';
export async function translateText(operation:LocalOperation,regions:readonly TextRegion[],signal:AbortSignal,token:string){
  const input=translationInput(regions);
  if(!Object.keys(input).length)return input;
  const checkpoint=await readCheckpoint(operation.job.id);
  if(checkpoint){
    if(checkpoint.updatedAt<Date.now()-86400000||checkpoint.fingerprint!==operation.fingerprint||JSON.stringify(checkpoint.input)!==JSON.stringify(input))throw new TextError('TEXT_CHECKPOINT_MISMATCH');
    if(checkpoint.state==='sending')throw new TextError('TEXT_OUTCOME_UNKNOWN');
    return checkpoint.result;
  }
  signal.throwIfAborted();
  const sending:TextCheckpoint={id:operation.job.id,entryId:operation.entryId,fingerprint:operation.fingerprint,input,state:'sending',updatedAt:Date.now(),bytes:0};
  await saveCheckpoint(sending);
  signal.throwIfAborted();
  const result=operation.config.provider==='google'
    ?await googleTranslate(input,operation.job.target_language,signal)
    :await llmTranslate(operation.config,input,operation.job.target_language,token,signal);
  await saveCheckpoint({...sending,state:'succeeded',result});
  return result;
}
