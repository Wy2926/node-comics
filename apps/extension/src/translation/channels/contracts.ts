import type {PageReference} from '../../comics/pages/identity';
import type {Capabilities, Job} from '../../types';
import type {ReadingTarget, TranslationState} from '../automatic';
import type {PreparedInput} from '../input/prepare';

/** Stable namespace for requests, results and page bindings. Never a credential. */
export interface TranslationScope { key: string }
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
  submit(targets:ReadingTarget[],isCurrent?:()=>boolean):Promise<void>;
  manual(target:ReadingTarget):Promise<void>;
  wait(signal:AbortSignal):Promise<boolean>;
  readonly hasPending:boolean;
  readonly waitingIds:readonly string[];
  readonly retryDelay:number;
  stateFor(target:ReadingTarget,active:boolean,error?:string):TranslationState|undefined;
  refresh():Promise<void>;
  dispose():void;
}
export interface ChannelConnection {
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
  configurable:boolean;
  fields:readonly ChannelField[];
  permissionOrigins?(input:ChannelConnectionInput):string[];
  connect?(input:ChannelConnectionInput):Promise<ChannelConnectionResult>;
  open(profile:ChannelProfile,secrets:Record<string,string>,isCurrent:()=>boolean):Promise<ChannelConnection>;
  subscribe?(listener:()=>void):()=>void;
}
