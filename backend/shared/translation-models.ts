/** Public identities only. Upstream configuration and credentials stay server-side. */
export interface TranslationModel {id:string;name:string;}
export interface TranslationModelChoice extends TranslationModel {
  requires_paid:boolean;
  available:boolean;
  unavailable_reason?:'not_allowed'|'quota_exhausted'|'unavailable'|null;
}
export function selectedModelAvailable(models:readonly TranslationModelChoice[]|undefined,id?:string){
  return id?models?.some(model=>model.id===id&&model.available)===true:models===undefined||models.some(model=>model.available);
}
export function translationModelChoices(models:readonly TranslationModelChoice[]|undefined,automatic:string,id?:string):TranslationModelChoice[]{
  const choices=[{id:'',name:automatic,available:selectedModelAvailable(models),requires_paid:false},
    ...[...(models??[])].sort((a,b)=>Number(a.requires_paid)-Number(b.requires_paid))];
  if(id&&!models?.some(model=>model.id===id))choices.push({id,name:id,available:false,requires_paid:false,unavailable_reason:'unavailable'});
  return choices;
}
