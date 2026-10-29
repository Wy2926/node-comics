/** One target map for admission, text services and the image pipeline. */
const targets={
  'zh-Hans':{google:'zh-CN',pipeline:'zh',prompt:'Simplified Chinese'},
  'zh-Hant':{google:'zh-TW',pipeline:'zh-CHT',prompt:'Traditional Chinese'},
  ja:{google:'ja',pipeline:'ja',prompt:'Japanese'},
  ko:{google:'ko',pipeline:'ko',prompt:'Korean'},
} as const;
export const localLanguages=Object.keys(targets);
export const supportsLocalLanguage=(language:string)=>Object.hasOwn(targets,language);
export function localLanguage(language:string){
  if(!supportsLocalLanguage(language))throw Error('TEXT_LANGUAGE_UNSUPPORTED');
  return targets[language as keyof typeof targets];
}
