export type SourceDiagnosticCode =
  | 'SOURCE_DATA_AMBIGUOUS'
  | 'SOURCE_DATA_FORMAT'
  | 'SOURCE_DATA_DECODE'
  | 'SOURCE_PAGES_INVALID'
  | 'SOURCE_TOTAL_MISMATCH'
  | 'SOURCE_IMAGE_URL_INVALID'
  | 'SOURCE_PAGE_COUNT_MISMATCH'
  | 'SOURCE_PAGE_ORDER_MISMATCH';

/** Only extension-owned diagnostic codes cross the adapter boundary. */
export class SourceError extends Error {
  constructor(readonly code: SourceDiagnosticCode) {
    super(code);
  }
}
