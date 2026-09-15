/** Shared UI steps for single-selection local imports in browser acceptance scripts. */
export async function completeLocalImport(page,{close=true}={}){
 const panel=page.getByRole('dialog',{name:'导入本地漫画'});await panel.waitFor();
 await page.waitForFunction(()=>!document.querySelector('.nc-import-item.checking'));
 const start=panel.getByRole('button',{name:/^(开始导入|导入其余所选)/});
 if(await start.count()){
  await start.click();
  await panel.locator('.nc-import-steps li:nth-child(3)[aria-current=step]').waitFor({timeout:120000});
 }
 if(close){
  await panel.getByRole('button',{name:'完成',exact:true}).click();await panel.waitFor({state:'hidden'});
  // Import now preserves the user's current view. Existing acceptance scenarios continue from the shelf.
  if(await page.getByLabel('跳转页码').count())await page.getByLabel('返回我的漫画',{exact:true}).click();
 }
}
