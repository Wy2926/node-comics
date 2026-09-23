import type { SourceCatalogSnapshot } from '../../sources';
import type { Work, ReadingUnit, Document, ReadingPosition } from '../domain';

export interface SourceCatalog extends SourceCatalogSnapshot { workId?: string; excludedEntryIds: string[]; }
export interface ImportAssignment { workId?: string; title: string; kind: ReadingUnit['kind']; role?: ReadingUnit['role']; unitId?: string; }
export interface WorkCardViewModel { work: Work; units: ReadingUnit[]; documents: Document[]; }
export interface SourceLabel { id:string; label:string; }
export interface LibraryViewModel { works: Work[]; units: ReadingUnit[]; documents: Document[]; positions?: ReadingPosition[]; documentSources?:Record<string,SourceLabel>; workSources?:Record<string,SourceLabel[]>; nextOffset?: number; }
export const emptyLibrary = (): LibraryViewModel => ({ works: [], units: [], documents: [] });
export interface DownloadTask { id: string; documentId: string; status: 'queued'|'running'|'paused'|'failed'|'complete'; generation: number; completed: number; total?: number; error?: string; updatedAt: number; [key: string]: unknown; }
