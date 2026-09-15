import {afterEach, expect, it, vi} from 'vitest';
import {Api} from '../src/api';

afterEach(() => vi.unstubAllGlobals());
const signed = {url: 'https://objects.example/bucket/page?X-Amz-Signature=test', expires_at: '2099-01-01T00:00:00Z', authorization_required: false};
function setup(access: object, responses: (Response | Error)[] = [new Response('image')]) {
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({close() {}})));
  const fetch = vi.fn(async (url: string | URL) => {
    if (String(url).endsWith('/access')) return Response.json(access);
    const result = responses.shift();
    if (result instanceof Error) throw result;
    return result;
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

it('downloads signed HTTPS objects without account tokens, cookies or referrers', async () => {
  const fetch = setup(signed);
  await new Api('https://api.example', 'private-token').image('page');
  expect(fetch.mock.calls[0][0]).toBe('https://api.example/v1/images/page/access');
  expect(fetch).toHaveBeenLastCalledWith(new URL(signed.url), expect.objectContaining({headers: {}, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store'}));
});

it('keeps Bearer authentication for local same-origin images', async () => {
  const fetch = setup({url: '/content', authorization_required: true});
  await new Api('https://api.example', 'token').image('page');
  expect(fetch).toHaveBeenLastCalledWith(new URL('https://api.example/content'), expect.objectContaining({headers: {Authorization: 'Bearer token'}}));
});

it.each([
  {url: 'https://external.example/content', authorization_required: true},
  {url: 'https://external.example/content'},
  {...signed, url: 'http://objects.example/page'},
  {...signed, url: 'https://user:password@objects.example/page'},
])('rejects unsafe download targets before sending a request: %j', async access => {
  const fetch = setup(access);
  await expect(new Api('https://api.example', 'token').image('page')).rejects.toMatchObject({code: 'INVALID_ASSET_ORIGIN'});
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([new Response('', {status: 403}), new TypeError('CORS rejected')])('renews an expired signature once, including opaque CORS failures', async failure => {
  const fetch = setup(signed, [failure, new Response('image')]);
  await new Api('https://api.example', 'token').image('page');
  expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/access'))).toHaveLength(2);
});

it('bounds failures and never falls back to proxying via the API', async () => {
  const fetch = setup(signed, [new TypeError('offline'), new TypeError('offline')]);
  await expect(new Api('https://api.example', 'token').image('page')).rejects.toMatchObject({code: 'ASSET_DOWNLOAD_FAILED'});
  expect(fetch).toHaveBeenCalledTimes(4);
});
