/** Public metadata text only; independent of image translation and website sources. */
export interface TextTranslationAdapter {
  readonly id: string;
  readonly name: string;
  translate(text: string, targetLanguage: string, signal: AbortSignal): Promise<string>;
}
export class TextTranslationError extends Error {
  constructor(readonly kind: 'unavailable' | 'invalid' | 'rate-limit', readonly retryAt?: number) {
    super('Text translation ' + kind);
  }
}
