import type {PageReference} from '../../comics/pages/identity';
import type {Capabilities, Job, TranslationModelChoice} from '../../types';
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
export interface ChannelField {key:string;label:string;type:'text'|'url'|'password';required?:boolean;placeholder?:string;}
export interface ChannelConnectionInput {settings:Record<string,string>;secrets:Record<string,string>;signal?:AbortSignal;}
export interface ChannelConnectionResult {settings:Record<string,string>;secrets:Record<string,string>;}
export interface RuntimeOptions {
  language: string;
  modelId?: string;
  getBlob: (key:string)=>Promise<Blob|undefined>;
  readOriginal?: (ref:PageReference)=>Promise<{blob:Blob;release:()=>void}>;
  onJobs: (jobs:Job[])=>Promise<void>;
  onChange: ()=>void;
  onInputConsumed?: (blobKey:string)=>Promise<void>;
  isCurrent: ()=>boolean;
  /** Screenshot callers durably prepare bytes before admission; never encode those bytes twice. */
  prepareInput?: (target:ReadingTarget,current:()=>boolean,limits?:Capabilities['limits'])=>Promise<PreparedInput>;
}
/** submit updates a reading window; it must not await an entire image translation. */
export interface ChannelRuntime {
  init():Promise<void>;
  /** Hydrate local receipts only; never waits for policy, admission or remote verification. */
  restore(targets:ReadingTarget[]):Promise<void>;
  submit(targets:ReadingTarget[],isCurrent?:(target:ReadingTarget)=>boolean):Promise<void>;
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
export interface ChannelConnection {
  readonly modelSelection?:ModelSelection;
  /** Low-cardinality product category; never a profile name, URL or protocol ID. */
  analyticsCategory?:'official'|'local';
  key: string;
  scope: TranslationScope;
  label: string;
  capabilities: Capabilities;
  available: boolean;
  unavailable?: TranslationState;
  requiresInternet: boolean;
  allowsFeedback: boolean;
  isCurrent: ()=>boolean;
  createRuntime(options:RuntimeOptions):ChannelRuntime;
  /** Read/validate/cache delivered bytes; never starts a translation. Safe for reader, inline and export. */
  readResult(job:Job,signal?:AbortSignal,original?:()=>Promise<Blob|undefined>):Promise<Blob>;
  dispose():void;
}
export interface ChannelDefinition {
  id:string;
  label:string;
  /** User-facing setup information, owned by the adapter. */
  description?:string;
  guideUrl?:string;
  configurable:boolean;
  fields:readonly ChannelField[];
  permissionOrigins?(input:ChannelConnectionInput):string[];
  connect?(input:ChannelConnectionInput):Promise<ChannelConnectionResult>;
  open(profile:ChannelProfile,secrets:Record<string,string>,isCurrent:()=>boolean,options?:{deferPolicy?:boolean}):Promise<ChannelConnection>;
  subscribe?(listener:()=>void):()=>void;
  /** Local source removal only; neither method may contact the translation service. */
  inspectLocalEntry?(entryId:string):Promise<LocalTranslationResultReference[]>;
  blockLocalEntry?(entryId:string):Promise<void>;
  removeLocalEntry?(entryId:string):Promise<void>;
}
