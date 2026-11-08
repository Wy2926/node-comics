import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appRelease } from '../src/data/app';
import { loadAppRelease, parseAppManifest } from '../src/lib/app-release';

const updates = appRelease.architectures.map(arch => ({
  platform: 'android', arch, version: '1.2.3', build: 8,
  url: `${appRelease.repository}/releases/download/v1.2.3/test-${arch}.apk`,
  page_url: `${appRelease.repository}/releases/tag/v1.2.3`,
}));
const manifest = { schema: 1, updates };

test('release parsing matches platform and architecture and chooses the newest build without freezing a version', () => {
  const newer = { ...updates[0], version: '2.0.0', build: 10, url: `${appRelease.repository}/releases/download/v2.0.0/new-arm64.apk` };
  const result = parseAppManifest({ ...manifest, updates: [newer, ...updates, { ...newer, platform: 'ios', build: 99 }] });
  assert.equal(result.size, 3);
  assert.equal(result.get('arm64-v8a')?.url, newer.url);
  assert.equal(result.get('arm64-v8a')?.version, '2.0.0');
  assert.equal(result.get('armeabi-v7a')?.url, updates[1].url);
  assert.equal(result.get('x86_64')?.url, updates[2].url);
});

test('incomplete, conflicting or unsafe manifests cannot create APK download links', () => {
  for (const value of [null, {}, { ...manifest, schema: 2 }, { ...manifest, updates: updates.slice(1) },
    { ...manifest, updates: [...updates, { ...updates[0], url: updates[1].url }] },
    ...['https://evil.example/file.apk', updates[0].page_url, 'javascript:alert(1)', updates[0].url + '?token=private'].map(url => ({ ...manifest, updates: [{ ...updates[0], url }, ...updates.slice(1)] })),
    { ...manifest, updates: [{ ...updates[0], build: 0 }, ...updates.slice(1)] },
  ]) assert.throws(() => parseAppManifest(value));
});

test('concurrent loads share one request, cache success, and retry after failure without returning stale packages', async t => {
  let requests = 0;
  let failing = false;
  const options: RequestInit[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    requests++;
    options.push(init);
    await Promise.resolve();
    return new Response(failing ? '{}' : JSON.stringify(manifest), { status: failing ? 503 : 200 });
  });
  const [first, second] = await Promise.all([loadAppRelease(true), loadAppRelease()]);
  assert.equal(requests, 1);
  assert.equal(first, second);
  await loadAppRelease();
  assert.equal(requests, 1);
  failing = true;
  await assert.rejects(loadAppRelease(true));
  await assert.rejects(loadAppRelease());
  assert.equal(requests, 3);
  failing = false;
  assert.equal((await loadAppRelease(true)).size, 3);
  assert.equal(options.at(-1)?.cache, 'reload');
  assert.equal(options.at(-1)?.credentials, 'omit');
});
