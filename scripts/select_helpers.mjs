/** Select by value through the custom combobox's associated listbox. */
export async function selectOption(locator,value){
 // getByLabel can also match the listbox carrying the same accessible label.
 const trigger=locator.and(locator.page().locator('[role="combobox"],select'));
 // The separate admin console still has native selects.
 if(await trigger.evaluate(element=>element.tagName==='SELECT')){
  await trigger.selectOption(value);return;
 }
 await trigger.click();
 const listboxId=await trigger.getAttribute('aria-controls');
 if(!listboxId)throw Error('Select trigger is missing aria-controls');
 const selectors=await trigger.evaluate((_,{listboxId,value})=>({
  listbox:`[role="listbox"]#${CSS.escape(listboxId)}`,
  option:`[role="option"][data-value="${CSS.escape(value)}"]`,
 }),{listboxId,value:String(value)});
 await trigger.page().locator(selectors.listbox).locator(selectors.option).click();
}
