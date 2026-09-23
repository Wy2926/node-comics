import { catalog } from '../repositories';
import type { ImportAssignment } from './types';

/** Ordered intent is metadata only, written before copying any user-selected bytes. */
export interface LocalImportJournal {
  id: string; revisionId: string; kind: 'file' | 'images'; title: string; assignment: ImportAssignment;
  files: { name: string; size: number; containerId?: string }[]; currentIndex: number;
  state: 'copying' | 'bytes-ready'; updatedAt: number; [key: string]: unknown;
}
export const importJournalId = (revisionId: string) => 'local-import:' + revisionId;
export async function beginImportJournal(revisionId: string, kind: LocalImportJournal['kind'], files: File[], assignment: ImportAssignment): Promise<LocalImportJournal> {
  const journal: LocalImportJournal = { id: importJournalId(revisionId), revisionId, kind, title: files[0]?.name.replace(/\.[^.]+$/, '') ?? assignment.title, assignment: { ...assignment }, files: files.map(file => ({ name: file.name, size: file.size })), currentIndex: 0, state: 'copying', updatedAt: Date.now() };
  await catalog.put('metadata', journal); return journal;
}
export async function recordCopiedFile(journal: LocalImportJournal, index: number, containerId: string): Promise<void> {
  journal.files[index] = { ...journal.files[index], containerId }; journal.currentIndex = index + 1;
  journal.state = journal.currentIndex === journal.files.length ? 'bytes-ready' : 'copying'; journal.updatedAt = Date.now();
  await catalog.put('metadata', journal);
}
export const completeImportJournal = (revisionId: string) => catalog.remove('metadata', importJournalId(revisionId));
