import type {MessageKey} from '../i18n/runtime';

export type ShortcutScope = 'global' | 'app' | 'reader' | 'web';
type Command = {id:string;label:MessageKey;scope:ShortcutScope;defaults:readonly string[];repeat?:boolean};

/** Data only: no business services, React, browser globals or i18n runtime in content scripts. */
export const shortcutCommands = [
  {id:'app.shortcuts',label:'键盘快捷键',scope:'global',defaults:['Shift+Slash']},
  {id:'app.library',label:'我的漫画',scope:'app',defaults:['Alt+Digit1']},
  {id:'app.discover',label:'发现',scope:'app',defaults:['Alt+Digit2']},
  {id:'app.search',label:'搜索漫画',scope:'app',defaults:['Alt+Digit3']},
  {id:'app.sites',label:'漫画网站',scope:'app',defaults:['Alt+Digit4']},
  {id:'app.downloads',label:'离线缓存',scope:'app',defaults:['Alt+Digit5']},
  {id:'app.settings',label:'外观与设置',scope:'app',defaults:['Alt+Comma']},
  {id:'app.import',label:'导入漫画',scope:'app',defaults:['Alt+KeyO']},
  {id:'reader.previous',label:'上一页',scope:'reader',defaults:['PageUp','KeyK'],repeat:true},
  {id:'reader.next',label:'下一页',scope:'reader',defaults:['PageDown','KeyJ'],repeat:true},
  {id:'reader.left',label:'按阅读方向向左翻页',scope:'reader',defaults:['ArrowLeft'],repeat:true},
  {id:'reader.right',label:'按阅读方向向右翻页',scope:'reader',defaults:['ArrowRight'],repeat:true},
  {id:'reader.first',label:'本章首页',scope:'reader',defaults:['Home']},
  {id:'reader.last',label:'本章末页',scope:'reader',defaults:['End']},
  {id:'reader.original',label:'查看原图',scope:'reader',defaults:['KeyO']},
  {id:'reader.translation',label:'查看译图',scope:'reader',defaults:['KeyT']},
  {id:'reader.compare',label:'并排对照',scope:'reader',defaults:['KeyC']},
  {id:'reader.directory',label:'打开目录',scope:'reader',defaults:['KeyD']},
  {id:'reader.settings',label:'阅读设置',scope:'reader',defaults:['KeyS']},
  {id:'reader.translationSettings',label:'翻译设置',scope:'reader',defaults:['Shift+KeyT']},
  {id:'reader.zoomIn',label:'放大',scope:'reader',defaults:['Equal','Shift+Equal'],repeat:true},
  {id:'reader.zoomOut',label:'缩小',scope:'reader',defaults:['Minus'],repeat:true},
  {id:'reader.zoomReset',label:'重置缩放',scope:'reader',defaults:['Digit0']},
  {id:'reader.layout',label:'切换阅读布局',scope:'reader',defaults:['KeyM']},
  {id:'reader.fit',label:'切换图片适应方式',scope:'reader',defaults:['KeyW']},
  {id:'reader.immersive',label:'沉浸阅读',scope:'reader',defaults:['KeyI']},
  {id:'reader.fullscreen',label:'切换全屏',scope:'reader',defaults:['KeyF']},
  {id:'reader.back',label:'返回书架',scope:'reader',defaults:[]},
  {id:'reader.find',label:'寻找其他语言',scope:'reader',defaults:[]},
  {id:'web.pause',label:'暂停或继续网页翻译',scope:'web',defaults:['Alt+Shift+KeyP']},
  {id:'web.original',label:'切换网页原图与译图',scope:'web',defaults:['Alt+Shift+KeyO']},
  {id:'web.close',label:'关闭网页翻译',scope:'web',defaults:['Alt+Shift+KeyX']},
  {id:'web.shortcuts',label:'键盘快捷键',scope:'web',defaults:['Alt+Shift+KeyK']},
] as const satisfies readonly Command[];

export type ShortcutId = typeof shortcutCommands[number]['id'];
export type ShortcutOverrides = Partial<Record<ShortcutId,readonly string[]>>;
export type ShortcutHandlers = Partial<Record<ShortcutId,(event:KeyboardEvent)=>void|boolean>>;
export const commandById = new Map<ShortcutId,Command>(shortcutCommands.map(command=>[command.id,command]));
