import {useCallback,useId,useLayoutEffect,useRef,useState} from 'react';
import {Icon} from '../icons';
import {msg} from '../i18n/runtime';
import {Notification} from '../ui/Notification';
import {bookmarkImageKey,bookmarkKey,type BookmarkLocation,type ReaderBookmark} from '../comics/application/bookmarks';
import {Thumbnail} from './Images';
import type {ReaderBookmarksController} from './useReaderBookmarks';
import './bookmarks.css';

export function bookmarkLabel(location:BookmarkLocation){
  if(location.documentLocation)return msg('阅读进度 {0}%',{'0':Math.round((location.documentLocation.totalProgression??0)*100)});
  return location.relativeOffset>=.01?msg('第 {0} 页 · 页内 {1}%',{'0':location.pageNumber,'1':Math.round(location.relativeOffset*100)})
    :msg('第 {0} 页',{'0':location.pageNumber});
}
export function BookmarkTools({bookmarks:b,open,onOpen}:{bookmarks:ReaderBookmarksController;open:boolean;onOpen():void}){
  return <div className="nc-bookmark-tools">
    <button aria-label={b.saved?msg('移除当前页书签'):msg('添加当前位置书签')} title={b.saved?msg('移除当前页书签'):msg('添加当前位置书签')} aria-pressed={b.saved} disabled={!b.current||b.busy} onClick={b.toggle}><Icon name="bookmark"/><span>{b.saved?msg('已加书签'):msg('加书签')}</span></button>
    <button data-reader-bookmarks-trigger="true" aria-label={msg('书签 {0}',{'0':b.count})} title={msg('书签')} aria-expanded={open} onClick={onOpen}><Icon name="list"/><span>{msg('书签')} <small>{b.count}</small></span></button>
  </div>;
}
export function BookmarkNotice({bookmarks:b,inside=false}:{bookmarks:ReaderBookmarksController;inside?:boolean}){
  if(!b.notice)return null;
  return <Notification className={`nc-bookmark-notice nc-reader-controls${inside?' inside':''}`} icon={null}
    message={b.notice.text} notificationKey={b.notice} tone={b.notice.tone??'info'} onClose={b.dismiss}
    duration={b.notice.action?10000:b.notice.tone==='error'?12000:3000} paused={b.busy}
    action={b.notice.action&&<button disabled={b.busy} onClick={()=>void b.act()}>{b.notice.action}</button>}/>;
}
function BookmarkRow({item,current,bookmarks:b}:{item:ReaderBookmark;current:boolean;bookmarks:ReaderBookmarksController}){
  const options=useRef<HTMLButtonElement>(null);
  const noteForm=useRef<HTMLFormElement>(null);
  const actionsId=useId();
  const resolveImage=useCallback((signal:AbortSignal)=>bookmarkImageKey(item,signal),[item.locationKey]);
  const finishEdit=()=>{setEditing(false);setMenu(false);requestAnimationFrame(()=>options.current?.focus({preventScroll:true}));};
  const [menu,setMenu]=useState(false),[editing,setEditing]=useState(false),[note,setNote]=useState(item.note);
  useLayoutEffect(()=>{if(editing)noteForm.current?.scrollIntoView({block:'nearest'});},[editing]);
  return <li className="nc-bookmark-row" data-current={current||undefined}>
    <div className="nc-bookmark-row-main">
      <button className="nc-bookmark-destination" aria-current={current?'location':undefined} disabled={b.busy} onClick={()=>b.jump(item)}>
        <span className="nc-bookmark-picture" aria-hidden="true">{item.documentLocation?<Icon name="book" size={28}/>:<><Thumbnail resolveKey={resolveImage}/><span className="nc-bookmark-page">{item.pageNumber}</span></>}</span>
        <span className="nc-bookmark-summary"><b>{bookmarkLabel(item)}</b><span className="nc-bookmark-title">{item.title}</span>{current&&<small className="nc-bookmark-reading"><Icon name="check" size={13}/>{msg('阅读中')}</small>}</span>
        {item.note&&!editing&&<span className="nc-bookmark-note-preview">{item.note}</span>}
      </button>
      <button ref={options} className="icon-button" aria-label={msg('书签选项')} title={msg('书签选项')} aria-expanded={menu} aria-controls={menu?actionsId:undefined} disabled={b.busy} onClick={()=>{if(menu)finishEdit();else setMenu(true);}}><Icon name="more"/></button>
    </div>
    {menu&&!editing&&<div id={actionsId} className="nc-bookmark-actions"><button className="button secondary small" disabled={b.busy} onClick={()=>{setNote(item.note);setEditing(true);}}><Icon name="message" size={16}/>{item.note?msg('修改备注'):msg('添加备注')}</button><button className="button danger small" onClick={event=>{const panel=event.currentTarget.closest('.nc-reader-drawer');void b.remove(item).then(ok=>{if(ok)requestAnimationFrame(()=>panel?.querySelector<HTMLButtonElement>('.nc-bookmark-destination,.nc-bookmark-current button')?.focus({preventScroll:true}));});}} disabled={b.busy}><Icon name="trash" size={16}/>{msg('删除书签')}</button></div>}
    {editing&&<form ref={noteForm} id={actionsId} className="nc-bookmark-note" onSubmit={event=>{event.preventDefault();void b.saveNote(item,note).then(saved=>{if(saved)finishEdit();});}}>
      <label>{msg('备注（可选）')}<textarea autoFocus rows={3} maxLength={200} value={note} onChange={event=>setNote(event.target.value)} onKeyDown={event=>{if(event.key==='Escape'&&!event.nativeEvent.isComposing){event.preventDefault();event.stopPropagation();finishEdit();}}}/></label>
      <span className="nc-bookmark-note-count" aria-hidden="true">{note.length}/200</span><button className="button secondary small" type="button" onClick={finishEdit}>{msg('取消')}</button><button className="button primary small" type="submit" disabled={b.busy}>{msg('保存')}</button>
    </form>}
  </li>;
}
export function BookmarkList({bookmarks:b}:{bookmarks:ReaderBookmarksController}){
  const currentKey=b.current&&bookmarkKey(b.current);
  return <div className="nc-bookmarks">
    <div className="nc-bookmark-scroll" aria-busy={b.loading}>
      <div className="nc-bookmark-current nc-comic-paper"><div><small>{msg('当前位置')}</small><b>{b.current?bookmarkLabel(b.current):msg('页面尚未就绪')}</b></div><button className={`button ${b.saved?'secondary':'primary'} small`} disabled={!b.current||b.busy} aria-pressed={b.saved} onClick={b.toggle}><Icon name={b.saved?'check':'bookmark'} size={17}/>{b.saved?msg('已加书签'):msg('加书签')}</button></div>
      {b.returnTo&&b.notice?.kind!=='return'&&<div className="nc-bookmark-return"><div><b>{b.returnTo.title}</b><small>{bookmarkLabel(b.returnTo)}</small></div><button className="button secondary small" disabled={b.busy} onClick={()=>void b.goBack()}>{msg('返回刚才')}</button></div>}
      <p className="nc-bookmark-local">{msg('仅保存在此设备 · 最新添加在前')}</p>
      {b.error?<div className="nc-bookmark-empty" role="alert"><Icon name="info" size={32}/><h3>{msg('无法读取书签')}</h3><button className="button secondary small" onClick={b.retry}>{msg('重试')}</button></div>:b.loading&&!b.items.length?<p className="nc-bookmark-empty" role="status">{msg('加载中…')}</p>:<>
        {!b.items.length?<div className="nc-bookmark-empty"><Icon name="bookmark" size={32}/><h3>{msg('还没有书签')}</h3><p>{msg('看到想回来的地方，点一下“加书签”。')}</p></div>:<ul>{b.items.map(item=><BookmarkRow key={item.id} item={item} current={item.locationKey===currentKey} bookmarks={b}/>)}</ul>}
        {b.items.length<b.count&&<button className="button secondary nc-bookmark-more" disabled={b.busy||b.loading} onClick={b.more}>{msg('加载更多书签')}</button>}
      </>}
    </div>
    <BookmarkNotice bookmarks={b} inside/>
  </div>;
}
