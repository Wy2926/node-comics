import type {PageReference} from '../../comics/pages/identity';
import type {Capabilities, Job, TranslationModelChoice, TranslationFontChoice} from '../../types';
import type {ReadingTarget, TranslationState} from '../automatic';
import type {PreparedInput} from '../input/prepare';

/** Stable namespace for requests, results and page bindings. Never a credential. */
export interface TranslationScope { key: string }
export interface LocalTranslationResultReference {imageSha256?:string;scope:string;key:string}
export interface ChannelProfile {
  id: string;
  adapterId: string;
  name: string;
  revision: number;
  settings: Record<string, string>;
}
export interface ChannelField {key:string;label:string;type:'text'|'url'|'password'|'number'|'select';required?:boolean;placeholder?:string;defaultValue?:string;options?:readonly {value:string;label:string}[];help?:string;advanced?:boolean;}
export interface ChannelResource {id:string;label:string;description?:string;category?:{id:string;label:string;description:string;languages?:readonly {id:string;label:string;supported:boolean}[]};languages?:Readonly<Record<string,{label:string;selected?:boolean}>>;required?:boolean;selected?:boolean;bytes:number;downloaded:number;state:'missing'|'downloading'|'paused'|'verifying'|'ready'|'error';detail?:string;license:string;source:string;}
export interface ChannelResources {
  read(language?:string):Promise<ChannelResource[]>;
  subscribe(listener:()=>void):()=>void;
  act(action:'download'|'pause'|'remove'|'verify',id?:string,language?:string):Promise<void>;
  stop?():Promise<void>;
}
export interface ChannelOptions {
  fields:readonly ChannelField[];
  values:Record<string,string>;
  settingsLabel?:string;
  save(values:Record<string,string>):Promise<void>;
  resources?:ChannelResources;
  services?:ChannelServiceSelection;
}
/** Adapter-owned named text services; the UI never reads or stores their credentials. */
export interface ChannelServiceSelection {
  label:string;
  description:string;
  addLabel:string;
  selectedId:string;
  items:readonly {id:string;label:string;description?:string;values?:Record<string,string>;savedSecrets?:readonly string[]}[];
  initialValues:Record<string,string>;
  fields(values:Record<string,string>):readonly ChannelField[];
  changeValues(previous:Record<string,string>,next:Record<string,string>):Record<string,string>;
  select(id:string):Promise<void>;
  save(values:Record<string,string>,id?:string):Promise<void>;
  remove(id:string):Promise<void>;
}
export interface ChannelLocalHost {dispatch(message:unknown):Promise<unknown>;dispose():Promise<void>;}
export interface ChannelConnectionInput {settings:Record<string,string>;secrets:Record<string,string>;signal?:AbortSignal;}
export interface ChannelConnectionResult {settings:Record<string,string>;secrets:Record<string,string>;}
export interface RuntimeOptions {
  language: string;
  modelId?: string;
  fontId?: string;
  getBlob: (key:string,signal?:AbortSignal)=>Promise<Blob|undefined>;
  readOriginal?: (ref:PageReference)=>Promise<{blob:Blob;release:()=>void}>;
  onJobs: (jobs:Job[])=>Promise<void>;
  onChange: ()=>void;
  onInputConsumed?: (blobKey:string)=>Promise<void>;
  isCurrent: ()=>boolean;
  /** Screenshot callers durably prepare bytes before admission; never encode those bytes twice. */
  prepareInput?: (target:ReadingTarget,current:()=>boolean,limits?:Capabilities['limits'],signal?:AbortSignal)=>Promise<PreparedInput>;
}
/** submit updates a reading window; it must not await an entire image translation. */
export interface ChannelRuntime {
  init():Promise<void>;
  /** Hydrate local receipts only; never waits for policy, admission or remote verification. */
  restore(targets:ReadingTarget[]):Promise<void>;
  submit(targets:ReadingTarget[],isCurrent?:(target:ReadingTarget)=>boolean,signal?:AbortSignal):Promise<void>;
  manual(target:ReadingTarget):Promise<void>;
  wait(signal:AbortSignal):Promise<boolean>;
  readonly hasPending:boolean;
  readonly waitingIds:readonly string[];
  readonly retryDelay:number;
  stateFor(target:ReadingTarget,active:boolean,error?:string):TranslationState|undefined;
  refresh():Promise<void>;
  dispose():void;
}
export interface ModelSelection {
  value?:string;
  models?:TranslationModelChoice[];
  select(value?:string):Promise<void>;
}
export interface FontSelection {
  value(language:string):string|undefined;
  fonts?:TranslationFontChoice[];
  description?:string;
  downloads?:FontDownloads;
  select(language:string,value?:string):Promise<void>;
}
export type FontDownload=Pick<ChannelResource,'id'|'bytes'|'downloaded'|'state'|'detail'>;
/** Only locally installable fonts expose downloads; remote channel font menus stay independent. */
export interface FontDownloads {
  read():Promise<FontDownload[]>;
  subscribe(listener:()=>void):()=>void;
  download(id:string):Promise<void>;
}
export interface ChannelConnection {
  readonly options?:ChannelOptions;
  readonly modelSelection?:ModelSelection;
  readonly fontSelection?:FontSelection;
  /** Low-cardinality product category; never a profile name, URL or protocol ID. */
  analyticsCategory?:'official'|'local';
  key: string;
  scope: TranslationScope;
  label: string;
  capabilities: Capabilities;
  available: boolean;
  unavailable?: TranslationState;
  requiresInternet: boolean;
  isCurrent: ()=>boolean;
  createRuntime(options:RuntimeOptions):ChannelRuntime;
  /** Current local authorization only, without downloading or composing result pixels. */
  validateResult():Promise<void>;
  /** Read/validate/cache delivered bytes; never starts a translation. Safe for reader, inline and export. */
  readResult(job:Job,signal?:AbortSignal,original?:()=>Promise<Blob|undefined>):Promise<Blob>;
  dispose():void;
}
export interface ChannelDefinition {
  id:string;
  label:string;
  /** User-facing setup information, owned by the adapter. */
  description?:string;
  /** Optional display badge, separate from the channel name. */
  status?:string;
  guideUrl?:string;
  configurable:boolean;
  /** Non-configurable adapters have one permanent profile, initialized on first selection. */
  defaultSettings?:Record<string,string>;
  fields:readonly ChannelField[];
  permissionOrigins?(input:ChannelConnectionInput):string[];
  connect?(input:ChannelConnectionInput):Promise<ChannelConnectionResult>;
  open(profile:ChannelProfile,secrets:Record<string,string>,isCurrent:()=>boolean,options?:{deferPolicy?:boolean}):Promise<ChannelConnection>;
  subscribe?(listener:()=>void):()=>void;
  startLocalHost?(changed:(busy:boolean)=>void):Promise<ChannelLocalHost>;
  /** Local source removal only; neither method may contact the translation service. */
  inspectLocalEntry?(entryId:string):Promise<LocalTranslationResultReference[]>;
  blockLocalEntry?(entryId:string):Promise<void>;
  removeLocalEntry?(entryId:string):Promise<void>;
}
