import {msg} from '../i18n/runtime';
import type {ReadingProgressStatus} from '../comics/application/reading-progress';
import './reading-progress.css';

/** Shared by document and image readers; synchronization never interrupts the page. */
export function ReadingProgressBadge({status='local'}:{status?:ReadingProgressStatus}) {
  const label={local:msg('本地进度'),pending:msg('待同步'),syncing:msg('同步中'),synced:msg('已同步')}[status];
  return <span className="nc-reading-progress nc-reader-controls" data-sync={status} role="status" aria-live="off"
    title={status==='pending'?msg('阅读位置已保存在本地，等待同步。'):status==='local'?msg('阅读位置仅保存在此设备。'):label}>
    <span className="nc-reading-progress-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" focusable="false">
        {status==='local'?<>
          <rect x="5" y="3" width="14" height="18" rx="2"/>
          <path d="M9 3v9l3-2 3 2V3M10 17h4"/>
        </>:status==='syncing'?<g className="nc-reading-progress-arrows">
          <path d="M4 10a8 8 0 0 1 13.5-3.8L20 9M20 4v5h-5M20 14a8 8 0 0 1-13.5 3.8L4 15M4 20v-5h5"/>
        </g>:<>
          <path d="M7 18H6a4 4 0 0 1-.6-8A6.5 6.5 0 0 1 18 8.5a4.5 4.5 0 0 1 3 5.5"/>
          {status==='pending'?<><circle cx="15" cy="16" r="5"/><path d="M15 13v3l2 1"/></>:<path d="m10 16 3 3 7-7"/>}
        </>}
      </svg>
    </span>
    <span className="nc-reading-progress-label">{label}</span>
  </span>;
}
