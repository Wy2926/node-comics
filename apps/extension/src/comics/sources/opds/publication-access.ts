import { msg } from '../../../i18n/runtime';
import type { ComicFormat } from '../../formats/contracts';
import {
  hasRel,
  isBitmap,
  isDirectAcquisition,
  isManifest,
  isPublicationDetail,
  mediaType,
  PSE_REL,
  type OpdsLink,
  type OpdsPublication,
} from './protocol';

export interface PublicationAccess {
  detail?: OpdsLink;
  manifest?: OpdsLink;
  pages?: OpdsLink[];
  template?: OpdsLink;
  files: { link: OpdsLink; format: ComicFormat }[];
  readable?: boolean;
  unavailableReason: string;
}

function fileFormat(link: OpdsLink): ComicFormat | undefined {
  if (link.indirect || link.encrypted || !isDirectAcquisition(link)) return;
  switch (mediaType(link.type)) {
    case 'application/zip':
    case 'application/x-cbz':
    case 'application/vnd.comicbook+zip':
      return 'cbz';
    case 'application/x-cbr':
    case 'application/vnd.comicbook-rar':
    case 'application/x-rar-compressed':
    case 'application/vnd.rar':
    case 'application/rar':
      return 'cbr';
    case 'application/pdf':
      return 'pdf';
    case 'application/x-mobipocket-ebook':
      return 'mobi';
    case 'application/epub+zip':
      return 'epub';
  }
}

function validPseTemplate(href: string): boolean {
  try {
    // Reject malformed paths and unsupported variables before publishing a readable hint.
    decodeURIComponent(new URL(href).pathname);
  } catch {
    return false;
  }
  const expanded = href
    .replaceAll('{pageNumber}', '0')
    .replaceAll('{maxWidth}', '')
    .replaceAll('{maxHeight}', '');
  return !/[{}]|%7[bd]/i.test(expanded);
}

export function safePse(link: OpdsLink): boolean {
  return (
    hasRel(link, PSE_REL) &&
    !link.indirect &&
    isBitmap(link) &&
    typeof link.count === 'number' &&
    Number.isSafeInteger(link.count) &&
    link.count > 0 &&
    link.count <= 20000 &&
    link.href.includes('{pageNumber}') &&
    validPseTemplate(link.href)
  );
}

function unavailableReason(publication: OpdsPublication): string {
  const restricted = publication.links.some(
    (link) =>
      link.indirect ||
      link.encrypted ||
      link.rels.some((rel) =>
        [
          'borrow',
          'buy',
          'subscribe',
          'http://opds-spec.org/acquisition/borrow',
          'http://opds-spec.org/acquisition/buy',
          'http://opds-spec.org/acquisition/subscribe',
        ].includes(rel),
      ),
  );
  if (restricted) return msg('此条目需要 DRM 解锁、借阅、购买或其他获取流程，暂不支持阅读。');
  if (publication.readingOrder || publication.links.some((link) => hasRel(link, PSE_REL))) {
    return msg('此条目的图片清单或页流格式暂不支持。');
  }
  return msg('此条目未提供可识别的漫画文件、图片清单或完整条目链接。');
}

/** One policy for catalog hints and opening; a detail/manifest link is not proof of its body format. */
export function publicationAccess(publication: OpdsPublication): PublicationAccess {
  const detail = publication.links.find(isPublicationDetail);
  const manifests = publication.links.filter(
    (link) =>
      isManifest(link) &&
      !link.indirect &&
      !link.encrypted &&
      (hasRel(link, 'self') || isDirectAcquisition(link)),
  );
  const manifest =
    manifests.find((link) => mediaType(link.type) === 'application/divina+json') ?? manifests[0];
  const readingOrder = publication.readingOrder;
  const pages =
    readingOrder?.length && readingOrder.length <= 20000 && readingOrder.every(isBitmap)
      ? readingOrder
      : undefined;
  const template = publication.links.find(safePse);
  const files = publication.links.flatMap((link) => {
    const format = fileFormat(link);
    return format ? [{ link, format }] : [];
  });
  const readable =
    pages || template || files.length
      ? true
      : detail || (!readingOrder?.length && manifest)
        ? undefined
        : false;
  return {
    detail,
    manifest,
    pages,
    template,
    files,
    readable,
    unavailableReason: unavailableReason(publication),
  };
}
