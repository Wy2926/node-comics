import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const login=vi.hoisted(()=>({launch:vi.fn()}));
vi.mock('../src/auth/auth-window',()=>({launchLoginWindow:login.launch}));
import {startOidc,type AuthConfig} from '../src/auth/oidc';

const config:AuthConfig={mode:'oidc',dev_auth:false,issuer:'https://identity.test',client_id:'public-client',
  audience:'https://api.test',authorization_endpoint:'https://identity.test/authorize',token_endpoint:'https://identity.test/token',scopes:'openid profile'};
beforeEach(()=>{
  login.launch.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('chrome',{runtime:{id:'test-extension'},identity:{launchWebAuthFlow:vi.fn(),getRedirectURL:()=> 'https://test.chromiumapp.org/oidc'},
    permissions:{contains:vi.fn(async()=>true),request:vi.fn(async()=>true)}});
  vi.stubGlobal('sessionStorage',{setItem:vi.fn(),removeItem:vi.fn()});
});
afterEach(()=>vi.unstubAllGlobals());

describe('OIDC with installed host access',()=>{
  it('keeps the business login and consent flow without requesting browser host permissions',async()=>{
    await expect(startOidc(config,'https://api.test')).rejects.toThrow('登录窗口已关闭');
    expect(chrome.permissions.contains).toHaveBeenCalledExactlyOnceWith({origins:['https://identity.test/*']});
    expect(chrome.permissions.request).not.toHaveBeenCalled();
    const url=new URL(login.launch.mock.calls[0][0]);
    expect(url.searchParams.get('prompt')).toBe('login consent');
    expect(url.searchParams.get('scope')?.split(' ')).toContain('offline_access');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(sessionStorage.removeItem).toHaveBeenCalledWith('nc-oidc-pending');
  });
  it('stops before creating login state or opening a login window when the browser revokes host access',async()=>{
    vi.mocked(chrome.permissions.contains).mockImplementation(async()=>false);
    await expect(startOidc(config,'https://api.test')).rejects.toThrow('网站访问权限');
    expect(chrome.permissions.request).not.toHaveBeenCalled();
    expect(login.launch).not.toHaveBeenCalled();expect(sessionStorage.setItem).not.toHaveBeenCalled();
  });
});
