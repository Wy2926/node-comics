import assert from 'node:assert/strict';
import {beforeEach, test} from 'node:test';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';

const values = new Map();
globalThis.sessionStorage = {getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)};
const source = await readFile(new URL('../src/api.ts', import.meta.url), 'utf8');
const {outputText} = ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022}});
const api = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
const config = {client_id: 'shared-client', authorization_endpoint: 'https://identity.example/authorize',
  token_endpoint: 'https://identity.example/token', audience: 'https://comics.example/api', scopes: 'openid profile'};
let assigned, replaced;
beforeEach(() => {
  values.clear(); api.saveToken(''); assigned = undefined; replaced = undefined;
  globalThis.location = {origin: 'https://comics.example', pathname: '/console-isolated/', search: '', hash: '#users',
    assign: value => {assigned = new URL(value);}};
  globalThis.history = {replaceState: (_state, _unused, value) => {replaced = value;}};
  globalThis.fetch = async () => {throw Error('Unexpected network request');};
});

test('new entry remains the exact redirect URI through PKCE and token exchange', async () => {
  await api.startLogin(config);
  const pending = JSON.parse(values.get('nc-admin-oidc'));
  assert.equal(assigned.searchParams.get('redirect_uri'), 'https://comics.example/console-isolated/');
  assert.equal(assigned.searchParams.get('client_id'), config.client_id);
  assert.equal(assigned.searchParams.get('resource'), config.audience);
  assert.equal(assigned.searchParams.get('code_challenge_method'), 'S256');
  const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pending.verifier))).toString('base64url');
  assert.equal(assigned.searchParams.get('code_challenge'), challenge);
  location.search = `?code=isolated-code&state=${pending.state}`;
  let exchanges = 0;
  globalThis.fetch = async (url, options) => {
    exchanges++;
    assert.equal(url, config.token_endpoint);
    assert.equal(options.body.get('redirect_uri'), pending.redirect);
    assert.equal(options.body.get('code_verifier'), pending.verifier);
    assert.equal(options.body.get('resource'), config.audience);
    return new Response(JSON.stringify({access_token: 'isolated-token'}));
  };
  await api.finishLogin(config);
  assert.equal(exchanges, 1);
  assert.equal(replaced, '/console-isolated/#users');
  assert.equal(values.get('nc-admin-session'), 'isolated-token');
  assert.equal(values.has('nc-admin-oidc'), false);
  await assert.rejects(api.finishLogin(config), /登录状态无效/);
  assert.equal(exchanges, 1);
});

for (const failure of ['state', 'path', 'expired']) {
  test(`reject ${failure} mismatch before token exchange`, async () => {
    await api.startLogin(config);
    const pending = JSON.parse(values.get('nc-admin-oidc'));
    location.search = `?code=test&state=${failure === 'state' ? 'wrong-state' : pending.state}`;
    if (failure === 'path') location.pathname = '/admin/';
    if (failure === 'expired') {
      pending.created = Date.now() - 600001;
      values.set('nc-admin-oidc', JSON.stringify(pending));
    }
    await assert.rejects(api.finishLogin(config), /登录状态无效/);
    assert.equal(api.hasSession(), false);
  });
}

test('identity denial clears callback parameters and allows starting again', async () => {
  await api.startLogin(config);
  const pending = JSON.parse(values.get('nc-admin-oidc'));
  location.search = `?error=access_denied&state=${pending.state}`;
  await assert.rejects(api.finishLogin(config), /身份服务未完成登录/);
  assert.equal(replaced, '/console-isolated/#users');
  assert.equal(api.hasSession(), false);
  await api.startLogin(config);
  assert.notEqual(JSON.parse(values.get('nc-admin-oidc')).state, pending.state);
});
