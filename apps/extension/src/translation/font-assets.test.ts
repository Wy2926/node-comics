import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe,expect,it} from 'vitest';
import {TRANSLATION_FONTS,defaultTranslationFont,translationFontName,translationFontPreview} from '../../../../backend/shared/translation-fonts';
import catalog from '../../../../backend/shared/translation-fonts.json';
import assets from '../../../../services/compute-node/assets.json';
import previews from '../../public/fonts/translation/sources.json';

const root=new URL('../../public/fonts/translation/',import.meta.url);
const bytes=(name:string)=>readFileSync(fileURLToPath(new URL(name,root)));
const digest=(data:Buffer)=>createHash('sha256').update(data).digest('hex');

describe('bundled translation font specimens',()=>{
  it('provides at least five language-scoped choices for every current target',()=>{
    for(const language of Object.keys(catalog.samples)){
      expect(TRANSLATION_FONTS.filter(font=>font.languages.includes(language)).length).toBeGreaterThanOrEqual(5);
    }
    expect(new Set(TRANSLATION_FONTS.flatMap(font=>font.languages))).toEqual(new Set(Object.keys(catalog.samples)));
    expect(Object.keys(catalog.samples)).toHaveLength(17);
    expect(translationFontPreview('gaegu','en')).toBeUndefined();
    expect(translationFontPreview('../other','zh-Hans')).toBeUndefined();
    expect(translationFontPreview('comic-relief','vi')).toBeUndefined();
  });
  it('assigns one supported explicit default to every translation language',()=>{
    expect(Object.keys(catalog.defaults).sort()).toEqual(Object.keys(catalog.samples).sort());
    expect(Object.keys(catalog.defaults)).toHaveLength(17);
    for(const [language,id] of Object.entries(catalog.defaults)){
      const font=defaultTranslationFont(language);
      expect(font?.id).toBe(id);expect(font?.languages).toContain(language);
      expect(translationFontPreview(id,language)?.sample).toBe(font?.names[language]);
    }
    expect(defaultTranslationFont('unsupported')).toBeUndefined();
  });
  it('keeps node sources, specimen metadata and notices checksum-pinned',()=>{
    let total=0;
    for(const font of TRANSLATION_FONTS){
      const original=assets.fonts.find(asset=>'id' in asset&&asset.id===font.id);
      const specimen=previews.fonts.find(asset=>asset.id===font.id)!;
      expect(original).toBeDefined();
      expect(specimen.languages).toEqual(font.languages);
      expect(Object.keys(font.names).sort()).toEqual([...font.languages].sort());
      expect(specimen.names).toEqual(font.names);
      expect(specimen.source).toEqual(original!.url);
      expect(specimen.source_sha256).toEqual(original!.sha256);
      expect(specimen.notice_sha256).toEqual(original!.notice_sha256);
      expect(specimen.source_version).not.toBe('');
      expect(specimen.license).toBe('SIL Open Font License 1.1');
      const data=bytes(specimen.file);
      expect(data.subarray(0,4).toString()).toBe('wOF2');
      expect(data.byteLength).toBe(specimen.bytes);
      expect(digest(data)).toBe(specimen.sha256);
      expect(digest(bytes(specimen.notice))).toBe(specimen.notice_sha256);
      total+=data.byteLength;
      for(const language of font.languages){
        const preview=translationFontPreview(font.id,language)!;
        expect(preview.url).toBe('/fonts/translation/'+specimen.file);
        expect(preview.sample).toBe(font.names[language]);
        expect(preview.sample.trim()).not.toBe('');
        expect(preview.sample).toBe(translationFontName(font,language));
      }
    }
    // Localized names and fixed phrases must never accidentally bundle full CJK fonts.
    expect(total).toBeLessThan(512*1024);
  });
});
