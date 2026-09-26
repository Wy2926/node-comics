import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {ReactElement} from 'react';
const preferences=vi.hoisted(()=>({read:vi.fn(()=>({autoTranslateTabs:false})),save:vi.fn(async()=>{})}));
vi.mock('react',()=>({useId:()=> 'hint',useRef:()=>({current:false}),useState:(value:unknown)=>[value,()=>{}]}));
vi.mock('../src/comics/application/preferences',()=>({settings:preferences.read,saveSettings:preferences.save}));
import {AutoTranslateTabs} from '../src/ui/AutoTranslateTabs';

const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function toggle(enabled:boolean,onSaved:()=>void){
  const view=AutoTranslateTabs({enabled,onSaved}) as ReactElement<{children:ReactElement<{children:ReactElement<{onClick:()=>void}>[]}>[]}>;
  view.props.children[0].props.children[1].props.onClick();
}
beforeEach(()=>{
  preferences.save.mockClear();
  vi.stubGlobal('chrome',{runtime:{id:'test-extension'},permissions:{contains:vi.fn(async()=>true),request:vi.fn(async()=>true)}});
});
afterEach(()=>vi.unstubAllGlobals());

describe('automatic tab toggle with installed host access',()=>{
  it('enables with existing access without requesting a new permission',async()=>{
    const saved=vi.fn();toggle(false,saved);await flush();
    expect(chrome.permissions.contains).toHaveBeenCalledWith({origins:['https://*/*','http://*/*']});
    expect(chrome.permissions.request).not.toHaveBeenCalled();
    expect(preferences.save).toHaveBeenCalledWith({autoTranslateTabs:true});expect(saved).toHaveBeenCalledOnce();
  });
  it('does not save an enabled preference when browser access was revoked',async()=>{
    vi.mocked(chrome.permissions.contains).mockImplementation(async()=>false);
    const saved=vi.fn();toggle(false,saved);await flush();
    expect(chrome.permissions.request).not.toHaveBeenCalled();expect(preferences.save).not.toHaveBeenCalled();expect(saved).not.toHaveBeenCalled();
  });
  it('still lets the user turn automatic tabs off after access is revoked',async()=>{
    vi.mocked(chrome.permissions.contains).mockImplementation(async()=>false);
    toggle(true,vi.fn());await flush();
    expect(chrome.permissions.contains).not.toHaveBeenCalled();expect(chrome.permissions.request).not.toHaveBeenCalled();
    expect(preferences.save).toHaveBeenCalledWith({autoTranslateTabs:false});
  });
});
