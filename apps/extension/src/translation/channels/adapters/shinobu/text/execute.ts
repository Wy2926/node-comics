import {readChannelCredentials} from '../../../configuration';
import {readCheckpoint,saveCheckpoint,type LocalOperation,type TextCheckpoint} from '../operations';
import {batches,TextError,type TextRegion} from './protocol';
import {googleTranslate} from './google';
import {llmTranslate} from './openai-compatible';
export async function translateText(operation:LocalOperation,regions:readonly TextRegion[],signal:AbortSignal):Promise<Record<string,string>>{
  const plan=batches(regions);
  let checkpoint=await readCheckpoint(operation.job.id);
  if(checkpoint){
    if(checkpoint.updatedAt<Date.now()-86400000||checkpoint.fingerprint!==operation.fingerprint||JSON.stringify(checkpoint.plan)!==JSON.stringify(plan))throw new TextError('TEXT_CHECKPOINT_MISMATCH');
  }else{
    checkpoint={id:operation.job.id,entryId:operation.entryId,fingerprint:operation.fingerprint,plan,batches:plan.map(()=>({state:'pending'})),updatedAt:Date.now(),bytes:0} satisfies TextCheckpoint;
    await saveCheckpoint(checkpoint);
  }
  const credentials=await readChannelCredentials(operation.profileId);
  if(!credentials.profile||credentials.profile.revision!==operation.profileRevision)throw new TextError('TEXT_CONFIG_CHANGED');
  const translated:Record<string,string>=Object.create(null);
  for(let i=0;i<plan.length;i++){
    signal.throwIfAborted();const previous=checkpoint.batches[i];
    if(previous.state==='sending')throw new TextError('TEXT_OUTCOME_UNKNOWN');
    if(previous.state==='succeeded'){Object.assign(translated,previous.result);continue;}
    checkpoint.batches[i]={state:'sending'};await saveCheckpoint(checkpoint);
    const timeout=AbortSignal.timeout(120_000),requestSignal=AbortSignal.any([signal,timeout]);
    const result=operation.config.provider==='google'
      ?await googleTranslate(plan[i],operation.job.target_language,requestSignal)
      :await llmTranslate(operation.config,plan[i],operation.job.target_language,credentials.secrets.token??'',requestSignal);
    checkpoint.batches[i]={state:'succeeded',result};await saveCheckpoint(checkpoint);Object.assign(translated,result);
  }
  return translated;
}
