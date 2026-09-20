import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oidcSettings, checkoutUrl, type AuthConfig } from '../src/lib/auth-config';
const config: AuthConfig = { mode:'oidc', dev_auth:false, issuer:'https://identity.example/oidc', client_id:'same-extension-client', audience:'https://comics.nodelane.net/api', authorization_endpoint:'https://identity.example/oidc/auth', token_endpoint:'https://identity.example/oidc/token', scopes:'openid profile offline_access' };
test('uses the existing public OIDC client, exact callback and API resource', () => {
  const settings = oidcSettings(config, 'https://comics.nodelane.net');
  assert.equal(settings.client_id,config.client_id);
  assert.equal(settings.redirect_uri,'https://comics.nodelane.net/auth/callback/');
  assert.equal(settings.response_type,'code');
  assert.notEqual(settings.disablePKCE,true);
  assert.deepEqual(settings.extraTokenParams,{resource:config.audience});
});
test('refuses development auth, unsafe endpoints, embedded credentials and missing resource', () => {
  for (const patch of [{dev_auth:true},{mode:'development'},{audience:''},{token_endpoint:'http://identity.example/token'},{authorization_endpoint:'https://secret@identity.example/auth'},{issuer:'javascript:alert(1)'}]) assert.throws(() => oidcSettings({...config,...patch},'https://comics.nodelane.net'));
});
test('checkout only navigates to the existing same-origin handoff', () => {
  assert.equal(checkoutUrl('/billing/checkout#token=opaque','https://comics.nodelane.net'),'https://comics.nodelane.net/billing/checkout#token=opaque');
  for (const value of ['https://evil.example/billing/checkout','//evil.example/','javascript:alert(1)','/account/','https://x@comics.nodelane.net/billing/checkout']) assert.throws(() => checkoutUrl(value,'https://comics.nodelane.net'));
});
