import {afterEach,describe,expect,it,vi} from 'vitest';
import {assetRecord} from '../../../../storage/local-assets/store';
import {localHostRequest} from '../../host-client';
import {fullFont,localFonts} from '../../../font-resources';
import {fontDownloads,resourceManager} from './resources';

vi.mock('../../../../storage/local-assets/store',()=>({assetRecord:vi.fn(async()=>undefined)}));
vi.mock('../../host-client',()=>({localHostRequest:vi.fn(async()=>{})}));
afterEach(()=>{vi.clearAllMocks();vi.unstubAllGlobals();});

describe('local font download capability',()=>{
  it('groups fonts by language with matching names, preferences and shared download identities',async()=>{
    const manager=resourceManager({ja:'klee-one',ko:'gaegu'}),resources=await manager.read();
    const fonts=resources.filter(item=>item.category?.id==='fonts');
    expect(new Set(fonts.map(font=>font.id)).size).toBe(fonts.length);
    expect(fonts[0].category?.languages?.filter(language=>language.supported).map(language=>language.id)).toEqual(['zh-Hans','zh-Hant','ja','ko']);
    expect(fonts[0].category?.languages?.find(language=>language.id==='en')?.supported).toBe(false);
    expect(fonts.find(font=>font.id==='font:klee-one')?.languages).toEqual({ja:{label:'クレー ワン',selected:true}});
    expect(fonts.find(font=>font.id==='font:gaegu')?.languages).toEqual({ko:{label:'개구체',selected:true}});
    const shared=fonts.find(font=>font.id==='font:noto-sans-cjk')!;
    expect(shared.languages?.['zh-Hans'].selected).toBe(true);expect(shared.languages?.ja.selected).toBe(false);
    expect(shared.languages?.ja.label).not.toBe(shared.languages?.['zh-Hans'].label);
    await manager.act('download');
    expect(localHostRequest).toHaveBeenCalledWith('shinobu',{action:'download',id:undefined,fontIds:['noto-sans-cjk','klee-one','gaegu']});
    await resourceManager({'zh-Hans':'lxgw-wenkai'}).act('download',undefined,'ko');
    expect(localHostRequest).toHaveBeenLastCalledWith('shinobu',{action:'download',id:undefined,fontIds:['lxgw-wenkai','noto-sans-cjk']});
    expect((await resourceManager().read('en')).filter(item=>item.required).map(item=>item.id)).not.toContain('font:noto-sans-cjk');
  });
  it('offers every model for download in ordinary builds',async()=>{
    const manager=resourceManager(),models=(await manager.read()).filter(item=>item.category?.id!=='fonts');
    expect(models).toHaveLength(5);expect(models.every(item=>item.state==='missing')).toBe(true);
    for(const model of models)await manager.act('download',model.id);
    expect(localHostRequest).toHaveBeenCalledTimes(5);
  });
  it('limits reads and download actions to fonts and distinguishes interrupted from live work',async()=>{
    const active=localFonts[0],paused=localFonts[1];
    vi.mocked(assetRecord).mockImplementation(async asset=>asset.id==='font:'+active.id||asset.id==='font:'+paused.id?{
      id:asset.sha256,state:'downloading',offset:1024,
    } as Awaited<ReturnType<typeof assetRecord>>:undefined);
    vi.stubGlobal('navigator',{locks:{query:async()=>({held:[{name:'nc-local-asset:'+fullFont(active.id).sha256}]})}});
    const states=await fontDownloads.read();
    expect(states.map(item=>item.id)).toEqual(localFonts.map(font=>font.id));
    expect(states.find(item=>item.id===active.id)).toMatchObject({state:'downloading',downloaded:1024});
    expect(states.find(item=>item.id===paused.id)).toMatchObject({state:'paused'});
    expect(assetRecord).toHaveBeenCalledTimes(localFonts.length);
    expect(vi.mocked(assetRecord).mock.calls.every(([asset])=>asset.id.startsWith('font:'))).toBe(true);
    expect(localHostRequest).not.toHaveBeenCalled();
    await fontDownloads.download(localFonts[0].id);
    expect(localHostRequest).toHaveBeenCalledExactlyOnceWith('shinobu',{action:'download',id:'font:'+localFonts[0].id});
    await expect(fontDownloads.download('detector')).rejects.toThrow('FONT_UNAVAILABLE');
    await expect(fontDownloads.download('font:'+localFonts[0].id)).rejects.toThrow('FONT_UNAVAILABLE');
    expect(localHostRequest).toHaveBeenCalledTimes(1);
  });
});
