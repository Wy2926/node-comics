import { ByteCache } from '../cache';
import {RENDER_PROFILE} from '../../comics/pages/identity';
/** Explicitly saved material. Only explicit delete/clear releases it; pressure and LRU never do. */
export const downloadStore = new ByteCache({ name: 'downloads', budgetBytes: Infinity, retained: true });
export const downloadKey = (contentId: string, pageId: string, renderProfileId = RENDER_PROFILE) => JSON.stringify(renderProfileId===RENDER_PROFILE ? [contentId,pageId] : [contentId,pageId,renderProfileId]);
