import {openSourceDatabase, type DatabaseSchema} from '../../storage/database';

/** Channel bindings start a separate baseline; source catalogs and positions stay intact. */
const schema:DatabaseSchema={
  translationBindings:{keyPath:'id',indexes:[{name:'imageSha256',keyPath:'imageSha256'},{name:'scope',keyPath:'scope'}]},
  tombstones:{keyPath:'id'},
};
let opening:Promise<IDBDatabase>|undefined;
export function openTranslationBindings():Promise<IDBDatabase>{
  return opening??=openSourceDatabase('channel-bindings',schema,()=>{opening=undefined;}).catch(error=>{opening=undefined;throw error;});
}
