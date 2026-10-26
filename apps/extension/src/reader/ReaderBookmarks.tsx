import {useRef,useState} from 'react';
import {Icon} from '../icons';
import {msg} from '../i18n/runtime';
import type {BookmarkLocation,ReaderBookmark} from '../comics/application/bookmarks';
import type {ReaderBookmarksController} from './useReaderBookmarks';
import './bookmarks.css';

export function bookmarkLabel(location:BookmarkLocation){
  if(location.documentLocation)return msg('阅读进度 {0}%',{'0':Math.round((location.documentLocation.totalProgression??0)*100)});
  return location.relativeOffset>=.01?msg('第 {0} 页 · 页内 {1}%',{'0':location.pageNumber,'1':Math.round(location.relativeOffset*100)})
    :msg('第 {0} 页',{'0':location.pageNumber});
}
export function BookmarkTools({bookmarks:b,open,onOpen,placement}:{bookmarks:ReaderBookmarksController;open:boolean;onOpen():void;placement:'desktop'|'mobile'}){
  return <div className={`nc-bookmark-tools ${placement}`}>
    <button aria-label={b.saved?msg('移除当前页书签'):msg('添加当前位置书签')} title={b.saved?msg('移除当前页书签'):msg('添加当前位置书签')} aria-pressed={b.saved} disabled={!b.current||b.busy} onClick={b.toggle}><Icon name="bookmark"/><span>{b.saved?msg('已加书签'):msg('加书签')}</span></button>
    <button data-reader-bookmarks-trigger="true" aria-label={msg('书签 {0}',{'0':b.count})} title={msg('书签')} aria-expanded={open} onClick={onOpen}><Icon name="list"/><span>{msg('书签')} <small>{b.count}</small></span></button>
  </div>;
}
export function BookmarkNotice({bookmarks:b,inside=false}:{bookmarks:ReaderBookmarksController;inside?:boolean}){
  if(!b.notice&&!b.returnTo)return null;
  return <div className={`nc-bookmark-notice nc-reader-controls${inside?' inside':''}`} role="status">
    <span>{b.notice?.text??msg('已跳转到书签')}</span>
    {(b.notice?.action||!b.notice&&b.returnTo)&&<button disabled={b.busy} onClick={b.act}>{b.notice?.action??msg('返回刚才')}</button>}
    <button className="icon-button" aria-label={msg('关闭提示')} onClick={b.dismiss}><Icon name="close" size={16}/></button>
  </div>;
}
function BookmarkRow({item,bookmarks:b}:{item:ReaderBookmark;bookmarks:ReaderBookmarksController}){
  const options=useRef<HTMLButtonElement>(null);
  const finishEdit=()=>{setEditing(false);setMenu(false);requestAnimationFrame(()=>options.current?.focus({preventScroll:true}));};
  const [menu,setMenu]=useState(false),[editing,setEditing]=useState(false),[note,setNote]=useState(item.note);
  return <li className="nc-bookmark-row">
    <div className="nc-bookmark-row-main">
      <button className="nc-bookmark-destination" disabled={b.busy} onClick={()=>b.jump(item)}>
        <span className="nc-bookmark-page" aria-hidden="true">{item.documentLocation?<Icon name="book"/>:item.pageNumber}</span>
        <span><b>{item.title}</b><small>{bookmarkLabel(item)}</small>{item.note&&<p>{item.note}</p>}</span>
      </button>
      <button ref={options} className="icon-button" aria-label={msg('书签选项')} aria-expanded={menu} disabled={b.busy} onClick={()=>setMenu(value=>!value)}>···</button>
    </div>
    {menu&&!editing&&<div className="nc-bookmark-actions"><button onClick={()=>{setNote(item.note);setEditing(true);}}>{item.note?msg('修改备注'):msg('添加备注')}</button><button onClick={event=>{const panel=event.currentTarget.closest('.nc-reader-drawer');void b.remove(item).then(ok=>{if(ok)requestAnimationFrame(()=>panel?.querySelector<HTMLButtonElement>('.nc-bookmark-destination,.nc-bookmark-current button')?.focus({preventScroll:true}));});}} disabled={b.busy}>{msg('删除书签')}</button></div>}
    {editing&&<form className="nc-bookmark-note" onSubmit={event=>{event.preventDefault();void b.saveNote(item,note).then(saved=>{if(saved)finishEdit();});}}>
      <label>{msg('备注（可选）')}<input autoFocus maxLength={200} value={note} onChange={event=>setNote(event.target.value)} onKeyDown={event=>{if(event.key==='Escape'&&!event.nativeEvent.isComposing){event.preventDefault();event.stopPropagation();finishEdit();}}}/></label>
      <button type="button" onClick={finishEdit}>{msg('取消')}</button><button type="submit" disabled={b.busy}>{msg('保存')}</button>
    </form>}
  </li>;
}
export function BookmarkList({bookmarks:b}:{bookmarks:ReaderBookmarksController}){
  return <div className="nc-bookmarks">
    <div className="nc-bookmark-current"><div><b>{msg('当前位置')}</b><small>{b.current?bookmarkLabel(b.current):msg('页面尚未就绪')}</small></div><button disabled={!b.current||b.busy} aria-pressed={b.saved} onClick={b.toggle}><Icon name="bookmark" size={17}/>{b.saved?msg('已加书签'):msg('加书签')}</button></div>
    <p className="nc-bookmark-local">{msg('仅保存在此设备 · 最新添加在前')}</p>
    <div className="nc-bookmark-scroll" aria-busy={b.loading}>
      {b.error?<p role="alert">{msg('无法读取书签')} <button onClick={b.retry}>{msg('重试')}</button></p>:b.loading&&!b.items.length?<p role="status">{msg('加载中…')}</p>:<>
        {!b.items.length?<div className="nc-bookmark-empty"><Icon name="bookmark" size={32}/><h3>{msg('还没有书签')}</h3><p>{msg('看到想回来的地方，点一下“加书签”。')}</p></div>:<ul>{b.items.map(item=><BookmarkRow key={item.id} item={item} bookmarks={b}/>)}</ul>}
        {b.items.length<b.count&&<button className="button secondary" disabled={b.busy} onClick={b.more}>{msg('加载更多书签')}</button>}
      </>}
    </div>
    <BookmarkNotice bookmarks={b} inside/>
  </div>;
}
