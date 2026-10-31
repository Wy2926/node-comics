/** Desktop acceptance against tests/manual_admin_completion_server.py only. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, writeFile, readFile} from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(import.meta.url);
let playwright;
try {playwright = require('playwright');} catch {
  playwright = require(path.resolve(path.dirname(process.execPath), '../node_modules/playwright'));
}
const origin = process.env.ADMIN_FIXTURE_URL || 'http://127.0.0.1:18090';
const controls = process.env.ADMIN_FIXTURE_CONTROLS;
assert(controls, 'Set ADMIN_FIXTURE_CONTROLS to the disposable control file printed by the server.');
assert((await (await fetch(`${origin}/v1/auth/config`)).json()).dev_auth, 'Requires disposable development fixture.');
const output = path.resolve('artifacts/admin-completion');
await mkdir(output, {recursive: true});
const browser = await playwright.chromium.launch({headless: true, channel: 'chrome'});
const context = await browser.newContext({viewport: {width: 1440, height: 1000}, locale: 'zh-CN', timezoneId: 'Asia/Shanghai'});
const page = await context.newPage();
page.setDefaultTimeout(12000);
const checks = [], errors = [];
page.on('pageerror', error => errors.push(error.message));
const visible = locator => locator.first().waitFor({state: 'visible'});
const shot = name => page.screenshot({path: path.join(output, `${name}.png`), fullPage: true});
const routes = {'概览': 'overview', '翻译任务': 'tasks', '计算节点': 'nodes', '翻译供应商': 'translation-providers', '用户管理': 'users', '产品与价格': 'billing', '订单管理': 'orders', '订阅与权益': 'subscriptions', '支付事件': 'billing-events', '翻译反馈': 'feedback', '服务健康': 'health', '用量与成本': 'statistics', '操作审计': 'audit', '系统设置': 'settings'};
const settled = () => page.waitForFunction(() => !Array.from(document.querySelectorAll('[aria-busy="true"]')).some(element => element.getClientRects().length));
const nav = async name => {
  await page.goto(`${origin}/console-test/#${routes[name]}`);
  await visible(page.getByRole('heading', {name, exact: true, level: 1}));
  await settled();
};
const close = async (dialog = page.getByRole('dialog')) => {
  await dialog.getByRole('button', {name: /关闭/}).first().click();
  await dialog.waitFor({state: 'detached'});
};
const authenticated = async endpoint => page.evaluate(async endpoint => {
  const response = await fetch(endpoint, {headers: {Authorization: `Bearer ${sessionStorage.getItem('nc-admin-session')}`}});
  return {status: response.status, body: await response.json()};
}, endpoint);
const loseOneResponse = async pattern => {
  await writeFile(controls, JSON.stringify({delay: 0, fail: false, lose_receipt: pattern}));
  return async () => {
    await visible(page.getByRole('alert'));
    const state = JSON.parse(await readFile(controls, 'utf8'));
    assert(!state.lose_receipt && state.committed_status < 300, `Mutation must commit before losing receipt: ${JSON.stringify(state)}`);
  };
};
try {
  await page.goto(`${origin}/console-test/`);
  await page.getByLabel('开发环境用户名').fill('admin');
  await page.getByRole('button', {name: '登录开发环境', exact: true}).click();
  await visible(page.getByRole('heading', {name: '概览', exact: true}));
  const navigation = ['概览', '翻译任务', '计算节点', '翻译供应商', '用户管理', '产品与价格', '订单管理', '订阅与权益', '支付事件', '翻译反馈', '服务健康', '用量与成本', '操作审计', '系统设置'];
  for (const name of navigation) {await nav(name); assert.equal(await page.locator('#main [role="alert"]').count(), 0, name);}
  checks.push('All 14 navigation pages load without application errors');

  await page.locator('#free_daily_pages').fill('88');
  await page.getByRole('button', {name: '保存系统设置', exact: true}).click();
  await visible(page.getByText(/系统设置已保存/));
  await shot('01-system-settings');
  checks.push('Quota defaults saved through versioned settings');

  await nav('翻译反馈');
  await page.getByRole('button', {name: '查看 / 处理'}).click();
  await page.getByLabel('处理状态').selectOption('reviewing');
  await page.getByLabel('处理备注').fill('隔离验收：已核对字号，进入处理');
  const restoreFeedback = await loseOneResponse('**/v1/admin/feedback/fixture-feedback');
  await page.getByRole('button', {name: '保存处理记录'}).click();
  await visible(page.getByRole('button', {name: '恢复原处理操作'}));
  await restoreFeedback(); await close();
  await page.getByRole('button', {name: '查看 / 处理'}).click();
  await page.getByRole('button', {name: '恢复原处理操作'}).click();
  await visible(page.getByRole('heading', {name: '处理历史'}));
  await settled();
  assert.equal(await page.getByRole('dialog').locator('tbody tr').count(), 1);
  await shot('04-feedback'); await close();
  checks.push('Feedback review retains exact request after dialog close and records only one history row');

  await nav('用户管理');
  await page.getByLabel('搜索', {exact: true}).fill('20000000-0000-4000-8000-000000000000');
  await page.getByRole('button', {name: '筛选', exact: true}).click();
  await page.getByRole('button', {name: '管理用户', exact: true}).click();
  await page.getByLabel('操作类型').selectOption('compensation');
  await page.getByLabel('补偿页数').fill('7');
  await page.getByLabel('操作备注').fill('隔离验收：补偿七页');
  const restoreMember = await loseOneResponse('**/v1/admin/users/*/quota-compensations');
  await page.getByRole('button', {name: '确认补偿'}).click();
  await visible(page.getByRole('button', {name: '重试并核实原操作'}));
  await restoreMember(); await close();
  await page.getByRole('button', {name: '管理用户', exact: true}).click();
  await page.getByRole('button', {name: '重试并核实原操作'}).click();
  await visible(page.getByRole('button', {name: '创建另一笔操作'}));
  for (const name of ['额度周期', '扣页账本', '预占任务', '会员操作']) {
    await page.getByRole('group', {name: '历史类别'}).getByRole('button', {name, exact: true}).click();
    await settled();
  }
  await shot('05-membership-history');
  await page.getByRole('button', {name: '创建另一笔操作'}).click();
  await page.getByLabel('操作类型').selectOption('expire');
  await page.getByLabel('操作备注').fill('隔离验收：提前结束运营会员');
  await page.getByRole('button', {name: '确认提前结束'}).click();
  await visible(page.getByRole('button', {name: '创建另一笔操作'}));
  await close();
  checks.push('Current quota compensation recovers lost receipt, membership expiry and four history tabs work');

  await nav('订单管理');
  await page.getByRole('button', {name: '查看订单 fixture-order'}).click();
  await visible(page.getByText('refund_fixture', {exact: true}));
  await shot('06-order-refunds'); await close();
  await nav('订阅与权益');
  assert.equal(await page.getByRole('button', {name: '订阅', exact: true}).getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', {name: '权益追溯', exact: true}).click();
  const subscription = page.getByRole('dialog', {name: '订阅权益追溯', exact: true});
  await visible(subscription.getByRole('heading', {name: '订阅周期', exact: true}));
  await visible(subscription.locator('.subscription-term'));
  assert.equal(await subscription.getByText('fixture-subscription-quota', {exact: true}).isVisible(), false);
  await shot('07-subscription');
  await subscription.getByText('关联编号与原结账', {exact: true}).click();
  await visible(subscription.getByText('creem:test:sub_fixture', {exact: true}));
  await subscription.getByText('额度桶编号', {exact: true}).click();
  await visible(subscription.getByText('fixture-subscription-quota', {exact: true}));
  await shot('07a-subscription-references'); await close(subscription);
  await page.getByRole('button', {name: '客户与试用资格'}).click();
  assert.equal(await page.getByRole('button', {name: '客户与试用资格', exact: true}).getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', {name: '试用资格', exact: true}).click();
  await settled(); await close();
  checks.push('Order per-refund details, subscription terms/monthly buckets and customer trial history render');

  await nav('支付事件');
  await page.getByRole('button', {name: '查看详情', exact: true}).click();
  await page.getByLabel('重试原因').fill('隔离验收：重新排队，无同步工作进程');
  const restoreEvent = await loseOneResponse('**/v1/admin/billing/events/*/retry');
  await page.getByRole('button', {name: '排入重试队列'}).click();
  await visible(page.getByRole('button', {name: '重试并核实原操作'}));
  await restoreEvent(); await close();
  await page.reload(); await page.getByRole('button', {name: '查看详情', exact: true}).click();
  await page.getByRole('button', {name: '重试并核实原操作'}).click();
  await visible(page.getByText('已确认操作受理。', {exact: true}));
  await shot('08-payment-event'); await close();
  checks.push('Payment event retry survives browser reload and confirms original receipt without requeue');

  await nav('服务健康'); await shot('09-health');
  await nav('用户管理');
  await page.getByLabel('搜索', {exact: true}).fill('星野同学');
  await page.getByRole('button', {name: '筛选', exact: true}).click();
  await page.getByRole('button', {name: '管理用户', exact: true}).click();
  await page.getByRole('tab', {name: '请求诊断', exact: true}).click();
  await visible(page.getByRole('heading', {name: '请求保护', exact: true}));
  await shot('10-user-diagnostics'); await close();
  await nav('用量与成本'); await shot('12-statistics');
  await nav('操作审计');
  assert((await authenticated('/v1/admin/audit')).body.total >= 5);
  await page.getByText('查看变更内容', {exact: true}).first().click(); await shot('13-audit');
  checks.push('User-scoped diagnostics, service health, separated statistics and audited operations load');

  let release;
  const pending = new Promise(resolve => {release = resolve;});
  await page.route('**/v1/admin/audit?*', async route => {
    await pending; await route.fulfill({status: 503, contentType: 'application/json', body: JSON.stringify({error: {message: '隔离验收：暂时不可用'}})});
  });
  await page.getByRole('button', {name: '刷新记录', exact: true}).click();
  await visible(page.getByText('正在读取审计记录…')); await shot('14-loading'); release();
  await visible(page.getByRole('alert')); await shot('15-error');
  await page.unroute('**/v1/admin/audit?*');
  await page.getByRole('button', {name: '刷新记录', exact: true}).click();
  await page.getByRole('alert').waitFor({state: 'detached'});
  await page.getByLabel('对象 ID', {exact: true}).fill('fixture-no-such-target');
  await page.getByRole('button', {name: '筛选', exact: true}).click();
  await visible(page.getByText('没有符合条件的操作记录。'));
  checks.push('Loading, stale error, refresh recovery and empty filtered state verified');

  await page.getByRole('button', {name: /退出登录/}).click();
  assert.equal(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('nc-admin-benefit:') || key.startsWith('nc-admin-billing-event:')).length), 0);
  await page.getByLabel('开发环境用户名').fill('fixture-ordinary-user');
  await page.getByRole('button', {name: '登录开发环境', exact: true}).click();
  await visible(page.getByText('此账户没有管理员权限，请使用管理员账户登录。'));
  assert.equal((await authenticated('/v1/admin/audit')).status, 401);
  const ordinary = await (await fetch(`${origin}/v1/auth/dev`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({username: 'fixture-ordinary-user'})})).json();
  assert.equal((await fetch(`${origin}/v1/admin/audit`, {headers: {Authorization: `Bearer ${ordinary.access_token}`}})).status, 403);
  await shot('16-access-denied');
  checks.push('Logout clears pending operation namespace; ordinary account denied UI and admin API');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({checks, pageErrors: errors, screenshots: output}, null, 2));
  await writeFile(path.join(output, 'report.json'), JSON.stringify({checks, pageErrors: errors, fixtureOnly: true}, null, 2));
} catch (error) {
  await shot('failure');
  console.error(await page.locator('body').innerText());
  throw error;
} finally {await browser.close();}
