import {useRef, useState} from 'react';
import {msg} from '../i18n/runtime';
import {Icon} from '../icons';
import {safeImageUrl} from '../sources';

/** Editing a link must not re-render the website directory. */
export function SiteLinkImport({onImport}: {onImport: (url: string) => Promise<void>}) {
  const [url, setUrl] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const running = useRef(false);
  async function submit() {
    if (running.current) return;
    running.current = true; setError(''); setBusy(true);
    try {await onImport(url.trim());}
    catch (error) {setError((error as Error).message);}
    finally {running.current = false; setBusy(false);}
  }
  return <form className="nc-site-link-import" onSubmit={event => {event.preventDefault(); void submit();}}>
    <label htmlFor="nc-site-url">{msg('通过链接添加漫画')}</label>
    <div><input id="nc-site-url" type="url" required value={url} onChange={event => {setUrl(event.target.value); setError('');}} placeholder={msg('粘贴漫画详情页或章节链接')} disabled={busy}/><button className="button primary" disabled={busy}><Icon name="plus"/>{busy ? msg('正在获取全部章节…') : msg('添加到书架')}</button></div>
    <p>{msg('粘贴已适配网站的漫画详情页或章节链接，读取目录后即可开始阅读。')}</p>
    {error && <p role="alert">{error} {safeImageUrl(url.trim(), url.trim()) && <a href={url.trim()} target="_blank" rel="noopener noreferrer">{msg('打开来源')}</a>}</p>}
  </form>;
}
