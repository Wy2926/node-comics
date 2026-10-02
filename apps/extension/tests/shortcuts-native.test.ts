import {afterEach,describe,expect,it,vi} from 'vitest';
import {browserShortcutBinding,canManageBrowserShortcuts,openBrowserShortcutSettings,readRegionShortcut} from '../src/shortcuts/native';

afterEach(()=>vi.unstubAllGlobals());
describe('native screenshot shortcut',()=>{
  it('reads the browser-assigned command rather than assuming its suggested key',async()=>{
    vi.stubGlobal('chrome',{commands:{getAll:async()=>[{name:'nc-translate-region',shortcut:'Ctrl+Shift+Y'}]},tabs:{create:vi.fn()}});
    expect(canManageBrowserShortcuts()).toBe(true);
    expect(await readRegionShortcut()).toBe('Ctrl+Shift+Y');
  });
  it('does not invent a binding in web previews or when the browser leaves it unassigned',async()=>{
    vi.stubGlobal('chrome',undefined);expect(canManageBrowserShortcuts()).toBe(false);expect(await readRegionShortcut()).toBeUndefined();
    vi.stubGlobal('chrome',{commands:{getAll:async()=>[{name:'nc-translate-region',shortcut:''}]},tabs:{create:vi.fn()}});
    expect(await readRegionShortcut()).toBeUndefined();
  });
  it.each([
    ['chrome-extension://id/','Chrome/140','chrome://extensions/shortcuts'],
    ['chrome-extension://id/','Chrome/140 Edg/140','edge://extensions/shortcuts'],
    ['moz-extension://id/','Firefox/140','about:addons'],
  ])('opens the native manager for %s / %s',async(base,userAgent,url)=>{
    const create=vi.fn();vi.stubGlobal('chrome',{runtime:{getURL:()=>base},commands:{getAll:vi.fn()},tabs:{create}});vi.stubGlobal('navigator',{userAgent});
    await openBrowserShortcutSettings();expect(create).toHaveBeenCalledWith({url});
  });
  it.each([['Alt+Shift+R','Alt+Shift+KeyR'],['Command+Shift+R','Shift+Meta+KeyR'],['⌥⇧R','Alt+Shift+KeyR'],['Ctrl+9','Ctrl+Digit9'],['Ctrl+Left','Ctrl+ArrowLeft']])('normalizes the native label %s for conflict checks', (label,binding)=>expect(browserShortcutBinding(label)).toBe(binding));
});
