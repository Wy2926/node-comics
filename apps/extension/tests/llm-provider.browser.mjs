// 在隔离的 5176 Vite 测试页中验证两个真实入口；供应商请求全部使用同源模拟响应。
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin='http://127.0.0.1:5176';

test('draft discovery, manual translation and editing from the reader',async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH});
  try{
    const page=await browser.newPage({viewport:{width:1180,height:850},locale:'zh-CN',serviceWorkers:'block'});
    page.setDefaultTimeout(10000);
    const requests=[];
    await page.route('**/*',route=>{
      const url=new URL(route.request().url());
      if(url.origin!==origin)return route.abort();
      if(!url.pathname.startsWith('/llm-fixture/'))return route.continue();
      requests.push({path:url.pathname,auth:route.request().headers().authorization});
      if(url.pathname==='/llm-fixture/missing/models')return route.fulfill({status:404,body:'<b>Missing model endpoint</b>'});
      if(route.request().postDataJSON()?.model==='short-output')return route.fulfill({json:{choices:[{finish_reason:'length',message:{content:'partial'}}]}});
      return route.fulfill({json:url.pathname.endsWith('/models')?{data:[{id:'vendor/first'},{id:'vendor/second'}]}
        :{id:'service-reply-42',choices:[{finish_reason:'stop',message:{reasoning_content:'x'.repeat(8500),content:'{"sample":"你好！"}'}}],usage:{total_tokens:20}}});
    });
    await page.goto(origin+'/tests/channel-fixture.html#settings',{timeout:60000});
    await page.getByRole('radio',{name:/浏览器本地翻译/}).click();
    const picker=page.getByRole('button',{name:'正文翻译服务',exact:true}),dialog=page.locator('dialog.nc-service-dialog:modal');
    const button=name=>dialog.getByRole('button',{name,exact:true});
    await picker.click();await page.getByRole('button',{name:'添加 LLM 供应商'}).click();
    const model=dialog.getByRole('combobox',{name:'模型名称',exact:true}),token=dialog.getByLabel('访问令牌',{exact:true});
    const list=dialog.getByRole('listbox',{name:'搜索模型'}),raw=dialog.locator('.nc-service-response');
    assert.equal(await model.inputValue(),'');
    await dialog.getByRole('combobox',{name:'供应商类型'}).click();await dialog.getByRole('option',{name:'自定义供应商'}).click();
    const base=dialog.getByLabel('服务地址',{exact:true});
    await base.fill(origin+'/llm-fixture/v1');await token.fill('draft-key');
    await button('获取模型').click();
    await list.getByRole('option',{name:'vendor/first'}).waitFor();
    await model.fill('SECOND');assert.equal(await list.getByRole('option').count(),1);
    await model.press('ArrowDown');await model.press('Enter');assert.equal(await model.inputValue(),'vendor/second');assert.equal(await list.count(),0);
    await model.fill('private-manual');await model.press('Tab');assert.equal(await model.inputValue(),'private-manual');
    await button('获取模型').click();await list.waitFor();assert.equal(await model.inputValue(),'private-manual');
    await model.press('Escape');assert(await dialog.isVisible());assert.equal(await list.count(),0);
    await raw.locator('summary').click();assert.match(await raw.locator('pre').innerText(),/vendor\/first/);
    await model.click();await list.getByRole('option',{name:'vendor/first'}).click();assert.equal(await model.inputValue(),'vendor/first');
    await button('测试翻译').click();await dialog.getByText('测试成功',{exact:true}).waitFor();
    await raw.locator('summary').click();assert.match(await raw.locator('pre').innerText(),/service-reply-42/);
    await raw.getByRole('button',{name:'查看全部'}).click();assert.equal(JSON.parse(await raw.locator('pre').innerText()).usage.total_tokens,20);
    await model.fill('manual-chat');assert.equal(await raw.count(),0);assert.equal(await dialog.getByText('测试成功').count(),0);
    const active=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('nc-translation-channels')).profiles.find(p=>p.adapterId==='shinobu').settings);
    assert.equal((await active()).textServices,'[]');
    await button('保存并使用').click();await dialog.waitFor({state:'detached'});assert.equal(JSON.parse((await active()).textServices)[0].values.model,'manual-chat');

    await page.evaluate(async()=>{(await import('/src/ui/release-notes/content.ts')).markReleaseNotesSeen();});
    await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'我的漫画'}).click();
    await page.locator('.nc-book-cover').first().click();
    await page.locator('.nc-translation-trigger:visible').first().click();
    await page.setViewportSize({width:375,height:650});
    await picker.click();await page.getByRole('button',{name:'编辑供应商 · manual-chat'}).click();
    assert.equal(await model.inputValue(),'manual-chat');assert.equal(await token.inputValue(),'');
    const bounds=await dialog.boundingBox();
    assert(Math.abs(bounds.x+bounds.width/2-187.5)<2&&Math.abs(bounds.y+bounds.height/2-325)<2);
    const footer=await button('保存并使用').boundingBox();assert(footer.y>=0&&footer.y+footer.height<=650);
    await button('获取模型').click();await list.waitFor();assert.equal(requests.at(-1).auth,'Bearer draft-key');
    const listBox=await list.boundingBox();assert(listBox.x>=0&&listBox.x+listBox.width<=376&&listBox.y+listBox.height<=651);
    await base.fill(origin+'/llm-fixture/missing');assert.equal(await list.count(),0);
    await button('获取模型').click();await dialog.getByRole('alert').waitFor();
    assert.match(await dialog.getByRole('alert').innerText(),/手动填写模型 ID.*HTTP 404/);assert.equal(requests.at(-1).auth,undefined);
    await raw.locator('summary').click();assert.equal(await raw.locator('pre').innerText(),'<b>Missing model endpoint</b>');assert.equal(await raw.locator('pre b').count(),0);
    await model.fill('short-output');await button('测试翻译').click();
    await dialog.getByText(/译文达到输出上限/).waitFor();
    await page.waitForFunction(()=>document.activeElement?.getAttribute('data-field')==='maxTokens');
    assert(await dialog.getByLabel('最大输出 Token').isVisible());
    await model.fill('still-manual');await button('测试翻译').click();await dialog.getByText('测试成功').waitFor();
    await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
    assert(await picker.evaluate(node=>node===document.activeElement));
    assert.equal(JSON.parse((await active()).textServices)[0].values.model,'manual-chat');
  }finally{await browser.close();}
});
