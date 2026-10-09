/** Run only against a freshly started manual_admin_completion_server.py fixture. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, writeFile, readFile} from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(import.meta.url);
let playwright;
try {playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');} catch {
  playwright = require(path.resolve(path.dirname(process.execPath), '../node_modules/playwright'));
}
const origin = 'http://127.0.0.1:18096';
const controls = process.env.ADMIN_FIXTURE_CONTROLS;
assert(controls && /nc-admin-ui-/.test(controls), 'Requires disposable ADMIN_FIXTURE_CONTROLS.');
assert((await (await fetch(`${origin}/v1/auth/config`)).json()).dev_auth, 'Requires development fixture.');
const output = path.resolve('artifacts/admin-quota-campaigns');
await mkdir(output, {recursive: true});
const browser = await playwright.chromium.launch({headless: true, channel: 'chrome'});
const context = await browser.newContext({viewport: {width: 1440, height: 1000}, locale: 'zh-CN', timezoneId: 'Asia/Shanghai'});
const page = await context.newPage();
page.setDefaultTimeout(12000);
const checks = [], errors = [], mutations = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => {
  if (request.url().includes('/v1/admin/quota-campaigns') && ['PUT', 'PATCH'].includes(request.method())) mutations.push({url: request.url(), method: request.method(), body: request.postData()});
});
const visible = locator => locator.first().waitFor({state: 'visible'});
const shot = name => page.screenshot({path: path.join(output, name + '.png'), fullPage: true});
const dialog = () => page.getByRole('dialog');
const campaignRow = name => page.getByRole('row').filter({has: page.getByText(name, {exact: true})});
const pending = () => page.getByRole('region', {name: '待核实的活动操作'});
const fault = values => writeFile(controls, JSON.stringify({delay: 0, fail: false, ...values}));
const api = async (endpoint = '', method = 'GET', body) => page.evaluate(async ({endpoint, method, body}) => {
  const response = await fetch('/v1/admin/quota-campaigns' + endpoint, {method, headers: {Authorization: `Bearer ${sessionStorage.getItem('nc-admin-session')}`, 'Content-Type': 'application/json'}, ...(body ? {body: JSON.stringify(body)} : {})});
  return {status: response.status, body: await response.json()};
}, {endpoint, method, body});
const read = async () => {const response = await api(); assert.equal(response.status, 200); return response.body;};
const refresh = async () => {
  await page.getByRole('button', {name: '刷新列表', exact: true}).click();
  await page.getByRole('button', {name: '刷新列表', exact: true}).waitFor();
};
const recover = async () => {
  await visible(page.getByText('隔离验收：操作已落库，模拟回执丢失', {exact: true}));
  assert.equal(JSON.parse(await readFile(controls, 'utf8')).committed_status, 200);
  const original = mutations.at(-1);
  await page.reload();
  await visible(pending());
  assert.equal(await page.getByRole('button', {name: '＋ 新建活动', exact: true}).isDisabled(), true);
  await page.getByRole('button', {name: '重试并核实原操作', exact: true}).click();
  await pending().waitFor({state: 'detached'});
  assert.deepEqual(mutations.at(-1), original, 'Recovery must replay exact ID, body and version');
};
try {
  await fault({});
  await page.goto(`${origin}/console-test/#quota-campaigns`);
  await page.getByLabel('开发环境用户名').fill('admin');
  await page.getByRole('button', {name: '登录开发环境', exact: true}).click();
  await visible(page.getByRole('heading', {name: '额度活动', exact: true, level: 1}));
  await visible(page.getByText('尚未创建额度活动', {exact: true}));
  assert.equal((await read()).total, 0, 'Use a fresh fixture database');
  await page.getByRole('button', {name: '＋ 新建活动'}).click();
  await dialog().getByLabel('活动名称', {exact: true}).fill('全用户初始赠送');
  assert.equal(await dialog().getByLabel('每人赠送页数').inputValue(), '');
  await dialog().getByLabel('每人赠送页数').fill('300');
  await fault({lose_receipt: '/v1/admin/quota-campaigns/*'});
  await dialog().getByRole('button', {name: '保存为暂停活动'}).click();
  await recover();
  let first = (await read()).items[0];
  assert.equal(first.enabled, false); assert.equal(first.pages, 300); assert.equal(first.validity_days, null);
  assert.equal((await read()).total, 1);
  await visible(campaignRow(first.name));
  checks.push('Empty state, no hardcoded quantity, paused creation and lost PUT response survive reload without duplicate campaigns');

  await campaignRow(first.name).getByRole('button', {name: '启用发放'}).click();
  await fault({lose_receipt: '/v1/admin/quota-campaigns/*'});
  await dialog().getByRole('button', {name: '确认启用'}).click();
  await recover();
  first = (await read()).items[0]; assert.equal(first.version, 2); assert.equal(first.enabled, true);
  for (let index = 0; index < 27; index++) {
    const response = await fetch(`${origin}/v1/auth/dev`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({username: `campaign-reader-${index}`})});
    assert.equal(response.status, 200);
  }
  await refresh(); await visible(campaignRow(first.name).getByText('27 人', {exact: true}));
  await shot('01-campaign-desktop');
  await campaignRow(first.name).getByRole('button', {name: '发放记录'}).click();
  await visible(dialog().getByText('共 27 条', {exact: false}));
  assert.equal(await dialog().getByRole('row').count(), 26);
  assert.equal(await dialog().getByRole('cell', {name: '永久有效', exact: true}).count(), 25);
  await dialog().getByRole('button', {name: '下一页'}).click();
  await visible(dialog().getByText(/第 26–27 条/));
  assert.equal(await dialog().getByRole('row').count(), 3);
  await shot('02-awards-pagination');
  await fault({fail: true});
  await dialog().getByRole('button', {name: '刷新记录'}).click();
  await visible(dialog().getByRole('alert'));
  assert.equal(await dialog().getByRole('row').count(), 3, 'Read failure preserves marked stale records');
  await fault({}); await dialog().getByRole('button', {name: '刷新记录'}).click();
  await dialog().getByRole('alert').waitFor({state: 'detached'});
  await dialog().getByRole('link').first().click();
  await visible(page.getByRole('heading', {name: '用户管理', exact: true, level: 1}));
  await page.getByRole('navigation').getByRole('link', {name: '额度活动', exact: true}).click();
  await visible(campaignRow(first.name));
  checks.push('Lost PATCH response recovery, real registration grants, 27 awards, record pagination, stale recovery and user navigation');

  await campaignRow(first.name).getByRole('button', {name: '暂停活动'}).click();
  await dialog().getByRole('button', {name: '确认暂停'}).click();
  await visible(campaignRow(first.name).getByRole('button', {name: '启用发放'}));
  first = (await read()).items[0]; assert.equal(first.version, 3);
  await campaignRow(first.name).getByRole('button', {name: '启用发放'}).click();
  assert.equal((await api('/' + first.id, 'PATCH', {enabled: false, expected_version: 3})).status, 200);
  assert.equal((await api('/' + first.id, 'PATCH', {enabled: false, expected_version: 4})).status, 200);
  await dialog().getByRole('button', {name: '确认启用'}).click();
  await visible(page.getByText(/活动已被其他操作更新/));
  assert.equal((await read()).items[0].enabled, false);
  assert.equal((await read()).items[0].version, 5);
  assert.equal(await pending().count(), 0);
  checks.push('Pause preserves grants; stale version does not override intervening enable/pause decisions');

  await campaignRow(first.name).getByRole('button', {name: '调整期限'}).click();
  await dialog().getByLabel('额度有效天数').fill('7');
  await dialog().getByLabel('停止发放时间').fill(new Date(Date.now() + 30 * 86400000 + 8 * 3600000).toISOString().slice(0, 19));
  await dialog().getByLabel('同步调整已到账额度的有效期').check();
  await dialog().getByLabel('调整原因').fill('隔离验收：同一活动七天有效，不重新赠送');
  await shot('05-duration-editor');
  await fault({lose_receipt: '/v1/admin/quota-campaigns/*/duration'});
  await dialog().getByRole('button', {name: '保存期限调整'}).click();
  await recover();
  first = (await read()).items[0];
  assert.equal(first.validity_days, 7); assert.equal(first.version, 6); assert.equal(first.awarded_users, 27);
  assert.equal((await read()).total, 1);
  const existing = (await api('/' + first.id + '/awards?limit=100')).body;
  assert.equal(existing.total, 27);
  assert(existing.items.every(row => row.grant.expires_at && Date.parse(row.grant.expires_at) - Date.parse(row.grant.starts_at) === 7 * 86400000));
  await shot('05-duration-corrected');
  await page.getByRole('navigation').getByRole('link', {name: '操作审计', exact: true}).click();
  await page.getByLabel('操作类型').selectOption('quota_campaign.duration');
  await page.getByRole('button', {name: '筛选', exact: true}).click();
  await visible(page.getByRole('cell', {name: /隔离验收：同一活动七天有效/}));
  await page.getByRole('button', {name: '查看变更内容'}).first().click();
  await visible(page.getByText('到账后有效天数', {exact: true}));
  await page.getByRole('navigation').getByRole('link', {name: '额度活动', exact: true}).click();
  await visible(campaignRow(first.name));
  checks.push('Same campaign duration correction updates 27 existing expiries without regrant; lost receipt and audit filtering recover correctly');

  await fault({fail: true}); await refresh();
  await visible(page.getByText(/当前列表可能已过时，已暂停配置操作/));
  assert.equal(await page.getByRole('button', {name: '＋ 新建活动'}).isDisabled(), true);
  assert.equal(await campaignRow(first.name).getByRole('button', {name: '启用发放'}).isDisabled(), true);
  await fault({}); await refresh();
  await campaignRow(first.name).getByRole('button', {name: '复制新活动'}).click();
  assert.equal(await dialog().getByLabel('每人赠送页数').inputValue(), '300');
  await dialog().getByLabel('活动名称', {exact: true}).fill('限时常规赠送');
  await dialog().getByLabel('每人赠送页数').fill('125');
  await dialog().getByLabel('翻译模式').selectOption('classic');
  await dialog().getByLabel('适用用户').selectOption('new');
  await dialog().getByLabel('额度有效天数').fill('45');
  await dialog().getByRole('button', {name: '保存为暂停活动'}).click();
  await visible(campaignRow('限时常规赠送'));
  const copied = (await read()).items.find(row => row.name === '限时常规赠送');
  assert.notEqual(copied.id, first.id); assert.equal(copied.enabled, false); assert.equal(copied.pages, 125);
  assert.equal(copied.mode, 'classic'); assert.equal(copied.audience, 'new'); assert.equal(copied.validity_days, 45);
  checks.push('Read failure blocks mutation, and copying creates distinct configurable rules while original receipts stay intact');

  await page.setViewportSize({width: 390, height: 844});
  await page.getByRole('button', {name: '＋ 新建活动'}).click();
  await visible(dialog());
  assert.equal(await dialog().getByLabel('活动名称', {exact: true}).evaluate(element => document.activeElement === element), true);
  await shot('03-mobile-form');
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No page-level horizontal overflow');
  for (const input of await dialog().locator('input, select').all()) {
    const box = await input.boundingBox(); assert(box && box.x >= 0 && box.x + box.width <= 390);
  }
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('button', {name: '＋ 新建活动'}).evaluate(element => document.activeElement === element), true);
  await shot('04-mobile-list'); await page.setViewportSize({width: 1440, height: 1000});
  checks.push('Desktop and narrow form geometry, accessible modal focus, Escape close and focus restoration');

  for (let index = 0; index < 25; index++) assert.equal((await api(`/fixture-list-${index}`, 'PUT', {name: `分页活动 ${index}`, pages: 1, mode: 'classic', audience: 'existing'})).status, 200);
  await refresh(); await visible(page.getByText('共 27 条', {exact: false}));
  await page.getByRole('button', {name: '下一页'}).click();
  await visible(page.getByText(/第 26–27 条/));
  assert.equal(await page.getByRole('row').count(), 3);
  await page.getByRole('button', {name: '＋ 新建活动'}).click();
  await dialog().getByLabel('活动名称', {exact: true}).fill('待核实操作退出');
  await dialog().getByLabel('每人赠送页数').fill('7');
  await fault({lose_receipt: '/v1/admin/quota-campaigns/*'});
  await dialog().getByRole('button', {name: '保存为暂停活动'}).click();
  await visible(pending()); await visible(page.getByRole('alert'));
  await page.getByRole('button', {name: /退出/}).click();
  await visible(page.getByRole('button', {name: '登录开发环境'}));
  assert.equal(await page.evaluate(() => sessionStorage.getItem('nc-admin-quota-campaign:pending')), null);
  checks.push('Campaign pagination and logout clears pending operation before another account can log in');
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'report.json'), JSON.stringify({checks, javascriptErrors: errors, mutationRequests: mutations.length}, null, 2));
  console.log(JSON.stringify({passed: checks.length, checks, javascriptErrors: errors}, null, 2));
} catch (error) {await shot('failure'); throw error;}
finally {await fault({}); await browser.close();}
