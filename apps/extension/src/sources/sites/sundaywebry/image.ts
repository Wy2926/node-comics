import type {SourceImageAdapter} from '../../contracts/image';
import {decodeBaku, parseProcessing} from './images';
import {pageUrl} from './protocol';

export const image: SourceImageAdapter = {
  async decode(blob, _headers, processing, signal) {
    signal?.throwIfAborted();
    return processing === undefined ? blob : decodeBaku(blob, parseProcessing(processing), signal);
  },
  async decodeInline(blob, _headers, url, signal) {
    // page.ts exposes HTTP targets only for validated baku pages. Other pixels use document-bound reads.
    pageUrl(url);
    return decodeBaku(blob, undefined, signal);
  },
};
