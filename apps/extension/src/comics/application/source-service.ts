import {catalog} from '../repositories';
import type {SourceAccount, SourceSelection} from '../sources/contracts';
import {getSourceDriver, listSourceDrivers, onSourceAccountsChanged, requireSourceDriver} from '../sources/registry';

export type {SourceSelection} from '../sources/contracts';

export function sourceImportOptions(): {id: string; label: string; configured: boolean}[] {
  return listSourceDrivers().filter(driver => !!driver.select).map(driver => ({
    id: driver.id, label: driver.label, configured: driver.isConfigured?.() ?? true,
  }));
}

export async function selectSourceFiles(providerId: string, connection?: SourceAccount, signal?: AbortSignal): Promise<SourceSelection> {
  signal?.throwIfAborted();
  const driver = requireSourceDriver(providerId);
  if (!driver.select) throw Error('此来源不提供文件选择入口。');
  if (driver.isConfigured?.() === false) throw Error('此来源尚未配置。');
  const selection = await driver.select(connection, signal);
  signal?.throwIfAborted();
  if (selection.connection.provider !== driver.id || !selection.connection.id)
    throw Error('所选文件的来源身份不匹配。');
  if (connection && (selection.connection.id !== connection.id || selection.connection.accountId !== connection.accountId))
    throw Error('所选来源账户与原连接不匹配。');
  return selection;
}

export const chooseSourceFiles = (providerId: string, signal?: AbortSignal) => selectSourceFiles(providerId, undefined, signal);

export function connectionCapabilities(connection: SourceAccount) {
  const driver = getSourceDriver(connection.provider);
  return {providerLabel: driver?.label ?? connection.provider,
    accountDetails: driver?.describeAccount?.(connection) ?? [],
    canReconnect: !!driver?.select && driver.isConfigured?.() !== false,
    canDisconnect: !!driver?.disconnect};
}

/** Account choices belong to source providers, even before any comic has been imported. */
export async function listSourceAccounts() {
  const providers=listSourceDrivers().filter(driver=>driver.listAccounts&&driver.isConfigured?.()!==false);
  const [saved,...results]=await Promise.allSettled([catalog.list('connections',{limit:1000}),...providers.map(async driver=>driver.listAccounts!())]);
  const accounts=new Map<string,SourceAccount>(),errors:{providerLabel:string;error:string}[]=[];
  if(saved.status==='rejected')throw saved.reason;
  for(const connection of saved.value) {
    const driver=getSourceDriver(connection.provider);
    if(connection.accountId||driver?.listAccounts||driver?.select||driver?.disconnect||driver?.describeAccount)accounts.set(connection.id,connection);
  }
  for(const [index,result] of results.entries()) {
    const driver=providers[index];
    if(result.status==='rejected'){errors.push({providerLabel:driver.label,error:result.reason instanceof Error?result.reason.message:String(result.reason)});continue;}
    const received=new Set<string>();
    for(const account of result.value) {
      const existing=accounts.get(account.id);
      if(!account.id||account.provider!==driver.id||existing&&(existing.provider!==driver.id||existing.accountId!==account.accountId)) {
        errors.push({providerLabel:driver.label,error:'来源账户身份不匹配。'});continue;
      }
      received.add(account.id);accounts.set(account.id,account);
    }
    for(const [id,account] of accounts)if(account.provider===driver.id&&!received.has(id)&&account.status==='connected')accounts.set(id,{...account,status:'reauth-required'});
  }
  const items=[...accounts.values()].map(account=>{
    try{return {...account,...connectionCapabilities(account)};}
    catch(error){errors.push({providerLabel:getSourceDriver(account.provider)?.label??account.provider,error:error instanceof Error?error.message:String(error)});
      return {...account,providerLabel:getSourceDriver(account.provider)?.label??account.provider,accountDetails:[],canReconnect:false,canDisconnect:false};}
  });
  return {accounts:items,errors};
}

export function subscribeSourceAccounts(listener:()=>void) {
  const catalogChanges=catalog.subscribe(change=>{if(change.table==='connections')listener();}),providerChanges=onSourceAccountsChanged(listener);
  return ()=>{catalogChanges();providerChanges();};
}

export async function getSourceAccount(id:string):Promise<SourceAccount> {
  const saved=await catalog.get('connections',id);
  if(saved)return saved;
  const {accounts,errors}=await listSourceAccounts(),account=accounts.find(item=>item.id===id);
  if(account)return account;
  throw Error(errors[0]?.error??'来源连接已移除。');
}
