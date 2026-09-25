import { ByteCache,type CacheWriteOptions } from '../cache';
import {invalidateResultMemory} from './memory';
import {initializeTranslationBudget,overrideTranslationBudget,translationBudgetBytes} from './policy';
class TranslationCache extends ByteCache {
  private ready?:Promise<void>;
  private initialize(){return this.ready??=initializeTranslationBudget(()=>{void this.enforceBudget().catch(()=>{});}).then(async()=>{const usage=await super.usage();await super.trim(Math.max(0,usage.bytes+usage.reservedBytes-translationBudgetBytes()));});}
  override async token(owner?:string){await this.initialize();return super.token(owner);}
  override async usage(){await this.initialize();return super.usage();}
  override async get(key:string){await this.initialize();return super.get(key);}
  override async has(key:string){await this.initialize();return super.has(key);}
  override async reserve(key:string,size:number,options:CacheWriteOptions={}){await this.initialize();return super.reserve(key,size,options);}
  override async clear(){await this.initialize();await super.clear();invalidateResultMemory();}
  override async delete(key:string){await this.initialize();await super.delete(key);invalidateResultMemory(key);}
  override async deleteOwner(owner:string,block=false){await this.initialize();await super.deleteOwner(owner,block);invalidateResultMemory(undefined,owner);}
}
export const translationCache = new TranslationCache({ name: 'translations', budgetBytes:translationBudgetBytes });
export async function setTranslationCacheLimitMb(mb: number): Promise<void> {
  overrideTranslationBudget(mb);await translationCache.enforceBudget();
}
