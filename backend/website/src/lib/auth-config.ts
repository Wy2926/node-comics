import type { UserManagerSettings } from 'oidc-client-ts';
export interface AuthConfig { mode: string; dev_auth: boolean; issuer: string; client_id: string; audience: string; authorization_endpoint: string; token_endpoint: string; scopes: string }
export function oidcSettings(config: AuthConfig, origin: string): UserManagerSettings {
  if (config.mode !== 'oidc' || config.dev_auth || !config.client_id || !config.audience) throw Error('正式登录服务尚未配置，请稍后重试或联系支持。');
  for (const value of [config.issuer, config.authorization_endpoint, config.token_endpoint, origin]) {
    const url = new URL(value);
    if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname)))) throw Error('身份服务地址无效。');
  }
  return {
    authority: config.issuer,
    client_id: config.client_id,
    redirect_uri: `${origin}/auth/callback/`,
    response_type: 'code',
    scope: config.scopes || 'openid profile offline_access',
    // Read endpoints from the same API config used by the extension; no new identity client.
    metadata: { issuer: config.issuer, authorization_endpoint: config.authorization_endpoint, token_endpoint: config.token_endpoint },
    loadUserInfo: false,
    automaticSilentRenew: false,
    monitorSession: false,
    staleStateAgeInSeconds: 600,
    requestTimeoutInSeconds: 15,
    extraQueryParams: { resource: config.audience, audience: config.audience },
    extraTokenParams: { resource: config.audience },
  };
}

export function checkoutUrl(value: string, portal = false) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== (portal ? 'billing.stripe.com' : 'checkout.stripe.com') || url.port || url.username || url.password) throw Error('结账地址无效，请联系支持。');
  return url.href;
}
