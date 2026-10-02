export const RENDER_PROFILE = 'original-v2-static-srgb';
export const PDF_RENDER_PROFILE = 'pdf-v3-static-srgb';
export const pageRenderProfile = (format:string) => format==='pdf' ? PDF_RENDER_PROFILE : RENDER_PROFILE;
export interface PageReference { entryId: string; contentId: string; pageId: string; renderProfileId: string; }
export const pageReference = (ref:PageReference) => 'page:'+JSON.stringify([ref.entryId,ref.contentId,ref.pageId,ref.renderProfileId]);
export function parsePageReference(value:string):PageReference|undefined {
  if(!value.startsWith('page:'))return;
  const parts:unknown=JSON.parse(value.slice(5));
  if(!Array.isArray(parts)||parts.length!==4||!parts.every(s=>typeof s==='string'&&s.length>0))throw Error('Invalid page reference');
  const [entryId,contentId,pageId,renderProfileId]=parts;return {entryId,contentId,pageId,renderProfileId};
}
