import {msg} from '../i18n/runtime';
import type {ReadingProgressStatus} from '../comics/application/reading-progress';
import './reading-progress.css';

/** Shared by document and image readers; synchronization never interrupts the page. */
export function ReadingProgressBadge({status='local'}:{status?:ReadingProgressStatus}) {
  const label={local:msg('本地进度'),pending:msg('待同步'),syncing:msg('同步中'),synced:msg('已同步')}[status];
  return <span className="nc-reading-progress" data-sync={status}
    title={status==='pending'?msg('阅读位置已保存在本地，等待同步。'):status==='local'?msg('阅读位置仅保存在此设备。'):label}>
    <i aria-hidden="true"/><span>{label}</span>
  </span>;
}
