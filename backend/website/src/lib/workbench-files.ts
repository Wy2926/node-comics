import type { TranslationModelChoice } from '../../../shared/translation-models';
import type { DocumentCapabilities } from './document-api';

/** Route metadata only; containers are never opened or copied by the browser. */
export function splitWorkbenchFiles(files: File[]) {
  const images: File[] = [], documents: File[] = [];
  for (const file of files) {
    if (/\.(pdf|zip|cbz)$/i.test(file.name)) documents.push(file);
    else images.push(file); // The existing image importer validates bytes and limits.
  }
  return { images, documents };
}

/** A mixed submission must use a model supported by both existing APIs. */
export function workbenchModels(images: TranslationModelChoice[] | undefined, documents: DocumentCapabilities | undefined, hasImages: boolean, hasDocument: boolean) {
  if (!hasDocument) return images;
  return (documents?.models ?? []).map(model => ({ ...model, requires_paid: true,
    available: !!documents?.enabled && !!documents.paid_allowed && (!hasImages || images?.some(image => image.id === model.id && image.available) === true),
  }));
}
