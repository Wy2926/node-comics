/** Starts run directly in the browser, independent of page focus and key handlers. */
export const browserShortcutCommands=[
  {name:'nc-translate-tab',label:'翻译当前标签页'},
  {name:'nc-translate-region',label:'划图翻译'},
] as const;
export type BrowserShortcuts=Partial<Record<typeof browserShortcutCommands[number]['name'],string>>;
export const canManageBrowserShortcuts=()=>typeof chrome!=='undefined'&&!!chrome.commands?.getAll&&!!chrome.tabs?.create;

export async function readBrowserShortcuts():Promise<BrowserShortcuts> {
  if(!canManageBrowserShortcuts())return {};
  const commands=await chrome.commands.getAll();
  return Object.fromEntries(browserShortcutCommands.flatMap(({name})=>{
    const shortcut=commands.find(command=>command.name===name)?.shortcut;
    return shortcut?[[name,shortcut]]:[];
  }));
}
export async function openBrowserShortcutSettings():Promise<void> {
  if(!canManageBrowserShortcuts())throw Error('Browser shortcut settings unavailable');
  const url=chrome.runtime.getURL('/').startsWith('moz-extension:')?'about:addons':navigator.userAgent.includes('Edg/')?'edge://extensions/shortcuts':'chrome://extensions/shortcuts';
  await chrome.tabs.create({url});
}

/** Convert commands.getAll's portable spelling for collision checks, not dispatch. */
export function browserShortcutBinding(shortcut:string|undefined):string|undefined {
  if(!shortcut)return;
  const parts=shortcut.replaceAll('⌘','Meta+').replaceAll('⌥','Alt+').replaceAll('⇧','Shift+').replaceAll('⌃','Ctrl+').split('+').map(part=>part.trim()).filter(Boolean);
  const raw=parts.pop();if(!raw)return;
  const code=/^[A-Za-z]$/.test(raw)?'Key'+raw.toUpperCase():/^\d$/.test(raw)?'Digit'+raw:({Up:'ArrowUp',Down:'ArrowDown',Left:'ArrowLeft',Right:'ArrowRight',Period:'Period',Comma:'Comma'} as Record<string,string>)[raw]??raw;
  const names=parts.map(part=>part==='Command'?'Meta':part==='MacCtrl'?'Ctrl':part);
  return ['Ctrl','Alt','Shift','Meta'].filter(part=>names.includes(part)).concat(code).join('+');
}
