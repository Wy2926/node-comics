import {afterEach, expect, it, vi} from 'vitest';
import {definition} from '../src/translation/channels/adapters/manga-translator-ui/definition';
import {languages, login, safeError, serviceBase, translationRequest} from '../src/translation/channels/adapters/manga-translator-ui/protocol';

afterEach(() => vi.unstubAllGlobals());
it('connects with the MTU login JSON and retains only token plus non-secret settings', async () => {
  const fetcher = vi.fn(async () => Response.json({success: true, token: 'fixture-token', user: {role: 'user'}}));
  vi.stubGlobal('fetch', fetcher);
  const input = {settings: {baseUrl: 'http://127.0.0.1:8000/prefix', username: ' local '}, secrets: {password: 'fixture-password'}};
  expect(definition.permissionOrigins!(input)).toEqual(['http://127.0.0.1:8000/*']);
  const saved = await definition.connect!(input);
  expect(saved).toEqual({settings: {baseUrl: 'http://127.0.0.1:8000/prefix/', username: 'local'}, secrets: {token: 'fixture-token'}});
  expect(JSON.stringify(saved)).not.toContain('fixture-password');
  const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('http://127.0.0.1:8000/prefix/auth/login');
  expect(init).toMatchObject({method: 'POST', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer'});
  expect(JSON.parse(init.body as string)).toEqual({username: 'local', password: 'fixture-password'});
});
it('accepts successful session metadata with no required password change', async () => {
  const token = 'f'.repeat(43);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    success: true, token, message: null, user: {username: 'fixture', role: 'admin', permissions: {}}, must_change_password: false,
  })));
  await expect(login('http://localhost/', 'fixture', 'fixture-password')).resolves.toBe(token);
});
it('encodes the documented form configuration without NodeLane account fields', () => {
  const request = translationRequest(serviceBase('http://localhost:8000'), 'fixture-token', 'classic', 'zh-Hant');
  expect(request.url).toBe('http://localhost:8000/translate/with-form/image');
  expect(request.headers).toEqual({'X-Session-Token': 'fixture-token'});
  expect(request.imageField).toBe('image');
  expect(JSON.parse(request.fields.config)).toEqual({translator: {target_lang: 'CHT'}});
  expect(languages.vi).toBe('VIN');
  expect(() => translationRequest('http://localhost/', 'token', 'redraw', 'zh-Hans')).toThrow('UNSUPPORTED_MODE');
  expect(() => translationRequest('http://localhost/', 'token', 'classic', 'unsupported')).toThrow('UNSUPPORTED_LANGUAGE');
});
it('rejects ambiguous service addresses and never shows server-provided credential or OCR details', async () => {
  for (const url of ['file:///tmp/service', 'https://user:password@example.com', 'https://example.com?key=private', 'https://example.com#token'])
    expect(() => serviceBase(url)).toThrow();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({success: false, message: 'PRIVATE_TOKEN PRIVATE_OCR'})));
  await expect(login('http://localhost/', 'user', 'password')).rejects.toThrow('用户名和密码');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({detail: 'PRIVATE_TOKEN PRIVATE_OCR'}, {status: 403})));
  await expect(login('http://localhost/', 'user', 'password')).rejects.toThrow(safeError('HTTP_403'));
});
it('reports malformed successful login responses as protocol errors rather than credential failures', async () => {
  for (const result of [null, [], 'invalid', {}, {success: 'true', token: 'token'}, {success: true},
    {success: true, token: 123}, {success: true, token: 'x\r\nheader'}, {success: true, token: ''}, {success: true, token: 'x'.repeat(8193)}]) {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(result)));
    await expect(login('http://localhost/', 'user', 'password')).rejects.toThrow('翻译服务返回的登录响应无效。');
  }
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Not JSON</html>')));
  await expect(login('http://localhost/', 'user', 'password')).rejects.toThrow('翻译服务返回的登录响应无效。');
});
it('reports required initial password changes before checking the token, only after successful login', async () => {
  for (const result of [{success: true, token: 'token', must_change_password: true}, {success: true, must_change_password: true}]) {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(result)));
    await expect(login('http://localhost/', 'user', 'password')).rejects.toThrow('请先在翻译服务页面修改初始密码，再重新连接。');
  }
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({success: false, must_change_password: true})));
  await expect(login('http://localhost/', 'user', 'password')).rejects.toThrow('翻译服务登录失败，请检查用户名和密码。');
});
it('reports login rate limiting without exposing server-provided details', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({detail: 'PRIVATE_TOKEN PRIVATE_OCR'}, {status: 429})));
  await expect(login('http://localhost/', 'user', 'password')).rejects.toThrow(safeError('HTTP_429'));
});
it('opens an independent channel without any NodeLane login or rights', async () => {
  const connection = await definition.open({id: 'local', adapterId: definition.id, name: 'Local GPU', revision: 2, settings: {baseUrl: 'http://localhost:8000'}}, {token: 'fixture-token'}, () => true);
  expect(connection.scope.key).toBe(JSON.stringify(['local', 2]));
  expect(connection.available).toBe(true); expect(connection.requiresInternet).toBe(false);
  expect(connection.capabilities.entitlements).toBeNull();
  expect(connection.capabilities.modes.map(mode => mode.id)).toEqual(['classic']);
  connection.dispose(); expect(connection.isCurrent()).toBe(false);
});
