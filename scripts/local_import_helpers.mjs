/** Local imports start automatically; single successful files open the reader. */
export async function completeLocalImport(page,{close=true}={}){
 await page.waitForFunction(()=>document.querySelector('img.nc-page-image')||document.querySelector('.nc-local-import-modal .nc-import-item.failed'),null,{timeout:120000});
 if(close){
  if(await page.getByLabel('返回我的漫画',{exact:true}).isVisible())await page.getByLabel('返回我的漫画',{exact:true}).click();
  const dock=page.locator('.nc-import-dock');if(await dock.isVisible())await dock.getByRole('button').click();
  const panel=page.locator('.nc-local-import-modal');if(await panel.isVisible())await panel.getByRole('button',{name:'完成',exact:true}).click();
 }
}
