import type {UiLocale} from '../i18n/locales';
import {msg,installDictionary,type Dictionary} from '../i18n/runtime';
import {rarContents} from './rar-core';
import wasmUrl from 'node-unrar-js/esm/js/unrar.wasm?url';
let pages:Awaited<ReturnType<typeof rarContents>>['pages'];
self.onmessage=async(event:MessageEvent<{file?:File;uiLocale:UiLocale;dictionary:Dictionary}>)=>{
  try {
    installDictionary(event.data.uiLocale,event.data.dictionary);
    if(event.data.file) {
      const wasm=await fetch(wasmUrl);
      if(!wasm.ok)throw Error(msg("RAR 解码器加载失败，请重新打开阅读器。"));
      const result=await rarContents(await event.data.file.arrayBuffer(),await wasm.arrayBuffer());
      pages=result.pages;
      self.postMessage({total:result.total});
    } else self.postMessage(pages.next());
  } catch(error) {
    const reason=(error as {reason?:string}).reason;
    self.postMessage({error:reason?.includes('PASSWORD')?msg("RAR 已加密，请在本机解密后导入。"):reason?msg("RAR 文件损坏、分卷不完整或压缩方式不支持。"):(error as Error).message});
  }
};
