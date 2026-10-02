// Composition root: consumers and the queue depend only on the adapter contract.
import {createGoogleTranslator} from './adapters/google';
import type {TextTranslationAdapter} from './contracts';
export const createTextTranslationAdapters = (): readonly TextTranslationAdapter[] => [createGoogleTranslator()];
