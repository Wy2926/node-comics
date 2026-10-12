import {Sha256} from '../importers/hash';
import {pageTranslation} from '../reader/presentation';
import type {Mode,Page} from '../types';

export type ReadingTarget={entryId:string;page:Page;mode:Mode};
export type TranslationState={kind:'waiting'|'translating'|'upgrade'|'error'|'login';message:string;retryable?:boolean;retryLabel?:string;retryAction?:'translate'};
const digest=(value:unknown)=>new Sha256().update(new TextEncoder().encode(JSON.stringify(value))).digest();
export const targetKey=(entryId:string,page:Page,mode:Mode)=>digest([entryId,page.contentId??null,page.id,mode]);
export function needsTranslation(page:Page,mode:Mode,language:string,scope:string){const t=pageTranslation(page,mode,language,scope);return !t.pending&&!t.ready&&!t.latest;}
