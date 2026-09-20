import {readFileSync,readdirSync,mkdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

/** Chrome's metadata is generated from the same per-language dictionaries as the UI. */
export function writeStoreLocales(){
  const source=new URL('./src/i18n/dictionaries/',import.meta.url);
  for(const file of readdirSync(source).filter(name=>name.endsWith('.json'))){
    const dictionary=JSON.parse(readFileSync(new URL(file,source),'utf8')) as Record<string,string>;
    const name=dictionary['store.name'],description=dictionary['store.description'],title=dictionary['brand.name'];
    if(!name||!description||!title||[...name].length>75||[...description].length>132)throw Error(`Invalid store metadata: ${file}`);
    const directory=new URL(`./public/_locales/${file.slice(0,-5).replace('-','_')}/`,import.meta.url);
    mkdirSync(directory,{recursive:true});
    writeFileSync(fileURLToPath(new URL('messages.json',directory)),JSON.stringify({extensionName:{message:name},extensionDescription:{message:description},actionTitle:{message:title}},null,2)+'\n');
    const uiDirectory=new URL('./public/i18n/',import.meta.url);
    mkdirSync(uiDirectory,{recursive:true});
    writeFileSync(fileURLToPath(new URL(file,uiDirectory)),JSON.stringify(dictionary)+'\n');
  }
}
