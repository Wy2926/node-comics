// Loopback-only Safari acceptance fixture. Synthetic identity and image results;
// no production credentials, remote images, suppliers, DB or billing calls.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {probeImageMetadata} from '../backend/shared/translation-images/image-metadata.ts';

const api = 'http://127.0.0.1:4737', site = 'http://localhost:4737';
const source = await readFile(fileURLToPath(new URL('../artifacts/import-validation/1.png', import.meta.url)));
// Returning a second synthetic page exercises result transport and decoding.
// It deliberately makes no claim of model quality.
const result = await readFile(fileURLToPath(new URL('../artifacts/import-validation/2.png', import.meta.url)));
const flows = new Map(), tokens = new Set(), refreshes = new Set(), tasks = new Map();
// Each fixture lifetime has an isolated synthetic account, just like its
// in-memory task database. A restart must not reuse old local receipts.
const userId = 'safari-fixture-' + randomUUID();
const probes = [];
const counts = {authorization: 0, exchange: 0, refresh: 0, me: 0, images: 0, refererRejected: 0,
  create: 0, replay: 0, input: 0, events: 0, result: 0, tokenOriginRemoved: true, failures: 0,
  nativeRequests: 0, nativeCredentialsOmitted: true, nativeCancelled: 0};
const hash = data => createHash('sha256').update(data).digest('hex');
const rights = {plan: 'free', image_rate_limit: {window_seconds: 60, limit: 10}, timezone: 'Asia/Shanghai',
  plus_started_at: null, plus_expires_at: null, pending_previous_period_pages: 0,
  modes: {classic: {allowed: true, unlimited: true, quota_kind: 'classic_unlimited', consent_version: 'fixture', quota: null}}};
const snapshot = id => {
  const task = tasks.get(id);
  if (!task) return undefined;
  const state = task.readyAt ? Date.now() >= task.readyAt ? 'succeeded' : 'running' : 'needs_input';
  return {id, state, mode: task.intent.mode, target_language: task.intent.target_language,
    requested_model_id: task.intent.model_id, font_id: task.intent.font_id, image_sha256: task.intent.image.sha256,
    created_at: task.createdAt, updated_at: task.readyAt ? new Date(task.readyAt).toISOString() : task.createdAt,
    result: state === 'succeeded' ? {kind: 'translated', representation: 'full-image-v1',
    input_sha256: task.intent.image.sha256, normalization_version: 1, width: 640, height: 960,
    artifact: {sha256: hash(result), byte_size: result.length, mime: 'image/png', path: '/v1/translations/' + id + '/result'}} : null};
};
const html = (response, body) => {
  response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'origin'});
  response.end(`<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NodeLane Safari 验证</title><style>body{font:18px system-ui;margin:24px auto;padding:16px;max-width:640px;background:#eff5ff;color:#20314a}button,a{display:inline-block;padding:16px;margin:8px}img{max-width:100%;height:auto}</style>${body}</html>`);
};
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, api);
    const json = (value, status = 200) => {
      response.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*'});
      response.end(JSON.stringify(value));
    };
    const error = (code, status = 400) => json({error: {code, message: code}}, status);
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization,Content-Type,X-Translation-Protocol,If-None-Match'});
      response.end(); return;
    }
    if (url.pathname === '/') return html(response, '<h1>Safari 技术验证</h1><p>本机合成测试；不调用真实身份或模型服务。</p><p>先在扩展阅读器登录，再回到本页，用扩展的“翻译当前页面”测试取图与翻译结果。</p><a href="/comic">公开图片取图与翻译</a><a href="/redirect-comic">重定向取图与翻译</a><a href="/protected-comic">严格防盗链（兼容性反例）</a>');
    if (['/comic', '/redirect-comic', '/protected-comic'].includes(url.pathname)) return html(response,
      `<h1>原创测试图片</h1><p>处理完成后，图片中的 PAGE 1 应变成 PAGE 2。这是模拟返回值。</p><img width="640" height="960" src="${api}/${url.pathname === '/protected-comic' ? 'source.png' : url.pathname === '/redirect-comic' ? 'public-redirect.png' : 'public.png'}">`);
    if (['/redirect.png', '/public-redirect.png'].includes(url.pathname)) { response.writeHead(302, {Location: api + (url.pathname === '/redirect.png' ? '/source.png' : '/public.png'), 'Cache-Control': 'no-store'}); response.end(); return; }
    if (url.pathname.startsWith('/native-')) {
      counts.nativeRequests++;
      counts.nativeCredentialsOmitted &&= !request.headers.cookie && !request.headers.authorization && !request.headers.origin;
      if (url.pathname === '/native-challenge.png') {response.writeHead(200, {'cf-mitigated':'challenge','Content-Type':'text/html'});response.end('synthetic challenge');return;}
      if (url.pathname === '/native-large.png') {response.writeHead(200, {'Content-Type':'image/png','Content-Length':33*1024*1024});response.flushHeaders();return;}
      if (url.pathname === '/native-stream-large.png') {
        response.writeHead(200, {'Content-Type':'image/png'});
        const chunk=Buffer.alloc(1024*1024);
        for(let i=0;i<33;i++)response.write(chunk);
        response.end();return;
      }
      if (url.pathname === '/native-slow.png') {
        response.writeHead(200, {'Content-Type':'image/png'});response.write(source.subarray(0,8));
        const timer=setTimeout(()=>response.end(source.subarray(8)),5000);
        response.on('close',()=>{clearTimeout(timer);if(!response.writableEnded)counts.nativeCancelled++;});return;
      }
      response.writeHead(200, {'Content-Type':'image/png','Set-Cookie':'native_fixture=must-not-be-replayed; Path=/'});response.end(source);return;
    }
    if (url.pathname === '/source.png' || url.pathname === '/public.png') {
      counts.images++;
      if (url.pathname === '/source.png' && request.headers.referer !== site + '/') { counts.refererRejected++; return error('REFERER_REQUIRED', 403); }
      response.writeHead(200, {'Content-Type': 'image/png', 'Cache-Control': 'no-store'}); response.end(source); return;
    }
    if (url.pathname === '/sample.cbz') {
      response.writeHead(200, {'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="Safari-fixture.cbz"'});
      response.end(await readFile(fileURLToPath(new URL('../artifacts/import-validation/pages.cbz', import.meta.url)))); return;
    }
    if (url.pathname === '/__state') return json({...counts, probes, tasks: [...tasks.keys()].map(id => ({id, state: snapshot(id).state}))});
    let body;
    if (['POST', 'PUT'].includes(request.method)) {
      const chunks = []; let length = 0;
      for await (const chunk of request) { length += chunk.length; assert(length <= 8 * 1024 * 1024, 'fixture input exceeds 8 MiB'); chunks.push(chunk); }
      body = Buffer.concat(chunks);
    }
    if (url.pathname === '/__probe' && request.method === 'POST') {
      assert(body.length <= 4096 && probes.length < 100);
      const value = JSON.parse(body); assert(typeof value.check === 'string' && typeof value.result === 'string');
      probes.push({check: value.check.slice(0, 80), result: value.result.slice(0, 500)}); return json({ok: true});
    }
    if (url.pathname === '/probe-origin') return json({originRemoved: !request.headers.origin, cookiesOmitted: !request.headers.cookie});
    if (url.pathname === '/probe-token-redirect') {response.writeHead(307, {Location: api + '/probe-origin'}); response.end(); return;}
    if (url.pathname === '/probe-large-response') {response.writeHead(200, {'Content-Type': 'application/json'}); response.write('x'.repeat(100000)); response.end('x'.repeat(100000)); return;}
    if (url.pathname === '/v1/auth/config') return json({mode: 'oidc', dev_auth: false, issuer: api, client_id: 'safari-fixture',
      audience: api, authorization_endpoint: api + '/authorize', token_endpoint: api + '/token', scopes: 'openid profile offline_access'});
    if (url.pathname === '/authorize') {
      const params = Object.fromEntries(url.searchParams);
      assert.equal(params.redirect_uri, api + '/auth/callback/'); assert.equal(params.code_challenge_method, 'S256');
      assert.equal(params.client_id, 'safari-fixture'); assert.equal(params.resource, api); assert(params.state);
      assert(flows.size < 50); const flow = randomUUID(); flows.set(flow, params); counts.authorization++;
      return html(response, `<h1>登录测试账户</h1><p>本机模拟身份服务。</p><form action="/complete"><input type="hidden" name="flow" value="${flow}"><button name="result" value="success">完成测试登录</button><button name="result" value="denied">拒绝授权</button></form>`);
    }
    if (url.pathname === '/complete') {
      const flow = url.searchParams.get('flow'), params = flows.get(flow); assert(params);
      const callback = new URL(params.redirect_uri); callback.searchParams.set('state', params.state);
      callback.searchParams.set(url.searchParams.get('result') === 'success' ? 'code' : 'error', url.searchParams.get('result') === 'success' ? flow : 'access_denied');
      response.writeHead(302, {Location: callback.href, 'Cache-Control': 'no-store'}); response.end(); return;
    }
    // Reproduce the production website removing callback parameters immediately.
    if (url.pathname === '/auth/callback/') return html(response, '<script>history.replaceState(null,"",location.pathname)</script><p>正在返回扩展…</p>');
    if (url.pathname === '/token') {
      const params = new URLSearchParams(body.toString());
      counts.tokenOriginRemoved &&= !request.headers.origin;
      if (request.headers.origin) return error('TOKEN_ORIGIN_NOT_REMOVED', 403);
      assert.equal(params.get('client_id'), 'safari-fixture'); assert.equal(params.get('resource'), api);
      if (params.get('grant_type') === 'refresh_token') {
        if (!refreshes.delete(params.get('refresh_token'))) return json({error: 'invalid_grant'}, 400);
        counts.refresh++;
      } else {
        const flow = params.get('code'), original = flows.get(flow); assert(original);
        assert.equal(params.get('redirect_uri'), original.redirect_uri);
        assert.equal(createHash('sha256').update(params.get('code_verifier')).digest('base64url'), original.code_challenge);
        flows.delete(flow); counts.exchange++;
      }
      const access = randomBytes(24).toString('hex'), refresh = randomBytes(24).toString('hex'); tokens.add(access); refreshes.add(refresh);
      return json({access_token: access, refresh_token: refresh, expires_in: 3600, token_type: 'Bearer'});
    }
    if (!tokens.has((request.headers.authorization ?? '').replace(/^Bearer /, ''))) return error('AUTH_REQUIRED', 401);
    if (url.pathname === '/v1/me') { counts.me++; return json({user: {id: userId, name: 'Safari 测试账户', role: 'reader'}, entitlements: rights}); }
    if (url.pathname === '/v1/me/entitlements') return json(rights);
    if (url.pathname === '/v1/capabilities') return json({result_protocol: 'overlay-v1', representations: ['overlay-v1', 'full-image-v1', 'original'],
      modes: [{id: 'classic', enabled: true, languages: ['zh-Hans', 'en']}], languages: [{id: 'zh-Hans', label: '简体中文'}, {id: 'en', label: 'English'}],
      limits: {max_bytes: 8388608, max_pixels: 60000000, max_dimension: 20000}, entitlements: rights});
    if (url.pathname === '/v1/translations' || url.pathname === '/v1/translations/events') {
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
      const batch = () => ({items: ids.map(snapshot).filter(Boolean), missing_ids: ids.filter(id => !tasks.has(id))});
      if (!url.pathname.endsWith('/events')) return json(batch());
      counts.events++; let previous = ''; const started = Date.now();
      response.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*'});
      const update = () => {
        const data = JSON.stringify(batch());
        if (data !== previous) { previous = data; response.write('event: snapshot\ndata: ' + data + '\n\n'); }
        if (ids.every(id => snapshot(id)?.state === 'succeeded')) response.end('event: end\ndata: {"reason":"complete"}\n\n');
        else if (Date.now() - started > 10000) response.end('event: end\ndata: {"reason":"reconnect"}\n\n');
      };
      const timer = setInterval(update, 100); response.on('close', () => clearInterval(timer)); update(); return;
    }
    const route = url.pathname.match(/^\/v1\/translations\/([a-f0-9-]{36})(?:\/(input|result))?$/);
    if (route) {
      const [, id, operation] = route;
      if (!operation && request.method === 'PUT') {
        assert.equal(request.headers['x-translation-protocol'], 'overlay-v1');
        const intent = JSON.parse(body); const {priority, ...identity} = intent;
        if (tasks.has(id)) { assert.deepEqual(tasks.get(id).identity, identity); counts.replay++; }
        else { assert(tasks.size < 50); assert(intent.image?.sha256); tasks.set(id, {intent, identity, createdAt: new Date().toISOString()}); counts.create++; }
        return json(snapshot(id), 202);
      }
      const task = tasks.get(id); if (!task) return error('TRANSLATION_NOT_FOUND', 404);
      if (operation === 'input' && request.method === 'PUT') {
        assert.equal(hash(body), task.intent.image.sha256); assert(await probeImageMetadata(new Blob([body])));
        task.readyAt ??= Date.now() + 800; counts.input++; return json(snapshot(id), 202);
      }
      if (operation === 'result') {
        assert.equal(snapshot(id).state, 'succeeded'); counts.result++;
        response.writeHead(200, {'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*'}); response.end(result); return;
      }
      return json(snapshot(id));
    }
    return error('FIXTURE_ROUTE_NOT_FOUND', 404);
  } catch {
    counts.failures++;
    if (!response.headersSent) response.writeHead(500, {'Content-Type': 'text/plain'});
    response.end('Synthetic fixture assertion failed');
  }
});
server.listen(4737, '127.0.0.1', () => console.log(`Safari fixture: ${site}\nBuild with VITE_API_BASE=${api}. Synthetic services only. Counters: ${api}/__state`));
