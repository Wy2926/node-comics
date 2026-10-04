import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import chinese from '../src/i18n/dictionaries/zh-CN.json';

const translation=vi.hoisted(()=>({page:vi.fn(),image:vi.fn(),region:vi.fn()}));
const browserMocks=vi.hoisted(()=>({tabGet:vi.fn<()=>Promise<chrome.tabs.Tab>>(),hostAccess:vi.fn<()=>Promise<boolean>>()}));
vi.mock('../src/inline/background',()=>({activateInline:translation.page,activateInlineImage:translation.image,registerInlineBackground:vi.fn()}));
vi.mock('../src/region/background',()=>({activateRegion:translation.region,registerRegionBackground:vi.fn()}));

const pageUrl='https://source.test/chapter';
const tab={id:7,url:pageUrl} as chrome.tabs.Tab;
const imageInfo:chrome.contextMenus.OnClickData={menuItemId:'nc-translate-image',editable:false,
  frameId:0,mediaType:'image',pageUrl,srcUrl:'https://images.test/page.png'};
let installed:()=>void;
let click:(info:chrome.contextMenus.OnClickData,tab?:chrome.tabs.Tab)=>Promise<void>;
let changed:(changes:Record<string,chrome.storage.StorageChange>,area:string)=>void;

beforeEach(async()=>{
  vi.resetModules();vi.clearAllMocks();
  browserMocks.tabGet.mockResolvedValue(tab);browserMocks.hostAccess.mockResolvedValue(true);
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json(chinese)));
  vi.stubGlobal('chrome',{
    runtime:{id:'test',getURL:(path:string)=>'chrome-extension://test/'+path.replace(/^\//,''),
      onInstalled:{addListener(fn:typeof installed){installed=fn;}},onMessage:{addListener:vi.fn()}},
    contextMenus:{create:vi.fn(),removeAll:vi.fn((callback:()=>void)=>callback()),
      update:vi.fn(async()=>{}),onClicked:{addListener(fn:typeof click){click=fn;}}},
    permissions:{contains:browserMocks.hostAccess},
    storage:{local:{get:vi.fn(async()=>({'nc-reader-settings':{uiLanguage:'en'}}))},
      onChanged:{addListener(fn:typeof changed){changed=fn;}}},
    tabs:{get:browserMocks.tabGet,create:vi.fn(async()=>({id:8})),query:vi.fn(async()=>[]),sendMessage:vi.fn()},
  });
  const {registerSourceBackground}=await import('../src/sources/runtime/background');
  registerSourceBackground();
  await vi.waitFor(()=>expect(chrome.contextMenus.update).toHaveBeenCalledTimes(3));
});
afterEach(()=>vi.unstubAllGlobals());

describe('image translation context menu',()=>{
  it('adds an image-only menu beside the existing page and region entries',async()=>{
    installed();
    await vi.waitFor(()=>expect(chrome.contextMenus.create).toHaveBeenCalledTimes(3));
    expect(chrome.contextMenus.create).toHaveBeenCalledWith({id:'nc-translate-image',title:'Translate image',
      contexts:['image'],documentUrlPatterns:['http://*/*','https://*/*']});
    expect(vi.mocked(chrome.contextMenus.create).mock.calls.map(([entry])=>entry.id))
      .toEqual(['nc-translate-page','nc-translate-image','nc-translate-region']);
  });

  it.each(['https://images.test/page.png','blob:https://source.test/image','data:image/png;base64,cGFnZQ=='])
    ('targets the clicked top-level image from %s without activating page translation',async srcUrl=>{
      const info={...imageInfo,srcUrl};
      await click(info,tab);
      expect(translation.image).toHaveBeenCalledExactlyOnceWith(7,info);
      expect(translation.page).not.toHaveBeenCalled();expect(translation.region).not.toHaveBeenCalled();
      expect(chrome.tabs.create).not.toHaveBeenCalled();
    });

  it.each([
    ['an iframe',{frameId:1}],['missing frame identity',{frameId:undefined}],
    ['a non-image context',{mediaType:'video'}],['missing image URL',{srcUrl:undefined}],
    ['empty image URL',{srcUrl:''}],['missing page URL',{pageUrl:undefined}],
    ['a different source page',{pageUrl:'https://source.test/another-chapter'}],
  ])('does not activate translation for %s',async(_label,change)=>{
    await click({...imageInfo,...change} as chrome.contextMenus.OnClickData,tab);
    expect(translation.image).not.toHaveBeenCalled();expect(translation.page).not.toHaveBeenCalled();
    expect(chrome.tabs.create).toHaveBeenCalledExactlyOnceWith({url:'chrome-extension://test/reader.html#settings'});
  });

  it.each(['https://source.test/another-chapter','chrome://settings/','file:///comic.png'])
    ('checks the current tab again and rejects a changed or unsupported URL: %s',async url=>{
      browserMocks.tabGet.mockResolvedValue({...tab,url});
      await click(imageInfo,tab);
      expect(translation.image).not.toHaveBeenCalled();
      expect(chrome.tabs.create).toHaveBeenCalledExactlyOnceWith({url:'chrome-extension://test/reader.html#settings'});
    });

  it('rejects a stale clicked tab even if its current page matches the menu snapshot',async()=>{
    await click(imageInfo,{...tab,url:'https://source.test/old-chapter'});
    expect(translation.image).not.toHaveBeenCalled();
    expect(chrome.tabs.create).toHaveBeenCalledOnce();
  });

  it.each(['permission','activation'])('uses the existing settings entry on %s failure',async stage=>{
    if(stage==='permission')browserMocks.hostAccess.mockResolvedValue(false);
    else translation.image.mockRejectedValueOnce(Error('Image is no longer available'));
    await click(imageInfo,tab);
    expect(chrome.tabs.create).toHaveBeenCalledExactlyOnceWith({url:'chrome-extension://test/reader.html#settings'});
    if(stage==='permission')expect(translation.image).not.toHaveBeenCalled();
  });

  it('updates the image menu title with the saved UI language',async()=>{
    vi.mocked(chrome.contextMenus.update).mockClear();
    changed({'nc-reader-settings':{oldValue:{uiLanguage:'en'},newValue:{uiLanguage:'zh-CN'}}},'local');
    await vi.waitFor(()=>expect(chrome.contextMenus.update).toHaveBeenCalledTimes(3));
    expect(chrome.contextMenus.update).toHaveBeenCalledWith('nc-translate-image',{title:'翻译图片'});
    expect(chrome.contextMenus.update).toHaveBeenCalledWith('nc-translate-page',{title:'翻译当前页面'});
    expect(chrome.contextMenus.update).toHaveBeenCalledWith('nc-translate-region',{title:'划图翻译'});
  });
});
