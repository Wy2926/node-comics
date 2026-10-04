// Run from apps/extension: node --test tests/select.firefox.mjs
// GECKODRIVER_PATH is required; FIREFOX_PATH defaults to the Windows installation.
// A stock Firefox with a temporary profile exercises the actual moz-extension principal.
import assert from 'node:assert/strict';
import {before, after, beforeEach, test} from 'node:test';
import {spawn} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {access, cp, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {fileURLToPath} from 'node:url';
import {dirname, join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {build} from 'vite';
import react from '@vitejs/plugin-react';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = resolve(root, '../../artifacts/firefox-select');
const fixture = join(artifacts, 'fixture');
const addonId = 'select-regression@node-comics.test';
const addonUuid = '8815d1d8-7948-4ff0-91fa-a210fcf89230';
const origin = `moz-extension://${addonUuid}`;
const firefox = process.env.FIREFOX_PATH || 'C:/Program Files/Mozilla Firefox/firefox.exe';
let driver, driverLog, endpoint, session, profile;

async function request(method, path, body) {
  const response = await fetch(`${endpoint}${path}`, {
    method, headers: {'content-type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const result = await response.json();
  if (!response.ok || result.value?.error) {
    throw new Error(`${method} ${path}: ${result.value?.error || response.status}: ${result.value?.message || ''}`);
  }
  return result.value;
}
const command = (method, path, body) => request(method, `/session/${session}${path}`, body);
const execute = (script, args = []) => command('POST', '/execute/sync', {script, args});
async function waitFor(script) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await execute(script)) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for: ${script}`);
}
async function click(selector, using = 'css selector') {
  const element = await command('POST', '/element', {using, value: selector});
  // Give React time to process blur between mouse press and release. An atomic
  // element-click command can dispatch click to an option that blur just hid.
  await command('POST', '/actions', {actions: [{type: 'pointer', id: 'mouse',
    parameters: {pointerType: 'mouse'}, actions: [
      {type: 'pointerMove', duration: 0, origin: element, x: 0, y: 0},
      {type: 'pointerDown', button: 0}, {type: 'pause', duration: 60}, {type: 'pointerUp', button: 0},
    ]}]});
}
async function state(selector) {
  return execute(`const element = document.querySelector(arguments[0]);
    return {value: element.dataset.value, expanded: element.getAttribute('aria-expanded'), focused: document.activeElement === element};`, [selector]);
}
const changes = () => execute("return JSON.parse(document.querySelector('#changes').textContent)");
const option = value => `.nc-select-list:popover-open [role="option"][data-value="${value}"]`;

async function cleanup() {
  if (session) {
    try {await command('DELETE', '');} catch (error) {console.error(`Firefox session cleanup: ${error.message}`);}
    finally {session = undefined;}
  }
  if (driver && driver.exitCode === null) {
    driver.kill();
    await new Promise(resolveExit => {
      driver.once('exit', resolveExit);
      const timeout = setTimeout(resolveExit, 2000);
      timeout.unref();
    });
  }
  driverLog?.end();
  if (profile) {
    assert.equal(dirname(profile), artifacts);
    await rm(profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
    profile = undefined;
  }
}

before(async () => {
  assert(process.env.GECKODRIVER_PATH, 'Set GECKODRIVER_PATH to the geckodriver executable.');
  await Promise.all([access(process.env.GECKODRIVER_PATH), access(firefox)]);
  await mkdir(artifacts, {recursive: true});
  await build({
    root, configFile: false, publicDir: false, base: '/', plugins: [react()], logLevel: 'warn',
    build: {outDir: fixture, emptyOutDir: true, rollupOptions: {input: join(root, 'tests/select-fixture.html')}},
  });
  await cp(join(root, 'public/flags'), join(fixture, 'flags'), {recursive: true});
  await writeFile(join(fixture, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'Node Comics Select regression', version: '1.0',
    background: {scripts: ['open-fixture.js']},
    browser_specific_settings: {gecko: {id: addonId, data_collection_permissions: {required: ['none']}}},
  }));
  await writeFile(join(fixture, 'open-fixture.js'), "browser.tabs.create({url: browser.runtime.getURL('tests/select-fixture.html')});");
  profile = await mkdtemp(join(artifacts, 'profile-'));
  const port = await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
  endpoint = `http://127.0.0.1:${port}`;
  driverLog = createWriteStream(join(artifacts, 'geckodriver.log'));
  // Firefox 153+ requires this opt-in even for refreshing an extension tab.
  // Scripts and trusted clicks still execute in the default content context.
  driver = spawn(process.env.GECKODRIVER_PATH, ['--allow-system-access', '--host', '127.0.0.1', '--port', String(port)], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  driver.stdout.pipe(driverLog);driver.stderr.pipe(driverLog);
  let spawnError;
  driver.once('error', error => {spawnError = error;});
  try {
    const deadline = Date.now() + 10_000;
    while (true) {
      if (spawnError) throw spawnError;
      if (driver.exitCode !== null) throw new Error('geckodriver exited; see artifacts/firefox-select/geckodriver.log');
      try {await request('GET', '/status');break;} catch (error) {
        if (Date.now() >= deadline) throw error;
        await delay(100);
      }
    }
    const created = await request('POST', '/session', {capabilities: {alwaysMatch: {
      browserName: 'firefox', 'moz:firefoxOptions': {
        binary: firefox, args: ['-headless', '-profile', profile],
        prefs: {'extensions.webextensions.uuids': JSON.stringify({[addonId]: addonUuid})},
      },
    }}});
    session = created.sessionId;
    assert.equal(await command('POST', '/moz/addon/install', {path: fixture, temporary: true}), addonId);
    // Firefox 153+ disallows direct WebDriver navigation to extension pages. Let
    // this temporary extension open its own page, then select that browser tab.
    const tabDeadline = Date.now() + 10_000;
    while (true) {
      let found = false;
      for (const handle of await command('GET', '/window/handles')) {
        await command('POST', '/window', {handle});
        if ((await command('GET', '/url')).startsWith(`${origin}/`)) {found = true;break;}
      }
      if (found) break;
      if (Date.now() >= tabDeadline) throw new Error('The temporary extension did not open its fixture tab.');
      await delay(50);
    }
    await command('POST', '/window/rect', {width: 1280, height: 1000});
    console.log(`Firefox ${created.capabilities.browserVersion}; temporary extension ${origin}`);
  } catch (error) {
    await cleanup();
    throw error;
  }
});
after(cleanup);

beforeEach(async () => {
  await command('POST', '/refresh', {});
  await waitFor("return !!document.querySelector('#work')");
  assert.equal(await execute('return location.origin'), origin);
  assert.equal(await execute('return browser.runtime.id'), addonId);
  await execute(`window.selectInput = [];
    for (const type of ['pointerdown', 'mousedown', 'blur', 'click']) {
      document.addEventListener(type, event => {
        window.selectInput.push({type, trusted: event.isTrusted, prevented: event.defaultPrevented,
          target: event.target.id, option: event.target.closest?.('[role=option]')?.dataset.value,
          focused: document.activeElement.id});
      }, type === 'blur' || type === 'click');
    }`);
});

test('mouse choice commits once and retains combobox focus in an extension page', async context => {
  await click('#work');
  await writeFile(join(artifacts, 'select-open.png'), Buffer.from(await command('GET', '/screenshot'), 'base64'));
  await click(option('banana'));
  const input = await execute('return window.selectInput');
  context.diagnostic(`Native Firefox input: ${JSON.stringify(input)}`);
  assert(input.some(event => event.type === 'pointerdown' && event.option === 'banana' && event.trusted));
  // defaultPrevented is diagnostic: the test remains valid if Mozilla fixes Bug 1484186.
  assert.deepEqual(await state('#work'), {value: 'banana', expanded: 'false', focused: true});
  assert.deepEqual(await changes(), [{
    target: {value: 'banana', name: 'work', id: 'work'},
    currentTarget: {value: 'banana', name: 'work', id: 'work'},
  }]);
});

test('disabled and already selected choices do not submit changes', async () => {
  await click('#work');
  await click(option('apricot'));
  assert.deepEqual(await state('#work'), {value: 'apple', expanded: 'true', focused: true});
  await click(option('apple'));
  assert.deepEqual(await state('#work'), {value: 'apple', expanded: 'false', focused: true});
  await click('button[aria-label="禁用选择"]');
  assert.equal((await state('button[aria-label="禁用选择"]')).expanded, 'false');
  assert.deepEqual(await changes(), []);
});

test('a choice inside a modal escapes clipping and preserves dialog focus', async () => {
  await click('//button[normalize-space()="Open dialog"]', 'xpath');
  const selector = 'dialog[open] [role="combobox"]';
  await click(selector);
  await click(option('banana'));
  assert.deepEqual(await state(selector), {value: 'banana', expanded: 'false', focused: true});
  assert.equal(await execute('return document.querySelector("dialog").open'), true);
  assert.equal((await changes()).length, 1);
});

test('the target language control can switch by mouse', async () => {
  const selector = '.nc-popup-language [role="combobox"]';
  await click(selector);
  await click(option('en'));
  assert.deepEqual(await state(selector), {value: 'en', expanded: 'false', focused: true});
  assert.deepEqual(await changes(), []);
});

test('a visible item in the bounded long list commits once', async () => {
  const selector = '#edge [role="combobox"]';
  await click(selector);
  assert(await execute(`const list = document.querySelector('.nc-select-list:popover-open');
    return list.scrollHeight > list.clientHeight && list.clientHeight <= 320;`));
  await click(option('3'));
  assert.equal((await state(selector)).expanded, 'false');
  assert.equal((await state(selector)).focused, true);
  const recorded = await changes();
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].currentTarget.value, '3');
});
