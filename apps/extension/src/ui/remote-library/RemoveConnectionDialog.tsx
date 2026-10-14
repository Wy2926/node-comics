import { useEffect, useRef, useState } from 'react';
import { msg } from '../../i18n/runtime';
import type { SourceAccount } from '../../comics/sources/contracts';
import { inspectSourceRemoval, removeSource } from '../../comics/application/source-lifecycle';
import { ConfirmationDialog, DialogNotice } from '../ConfirmationDialog';
import './remote-library.css';

export function RemoveConnectionDialog({ account, onClose, onRemoved }: {
  account: SourceAccount;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const [resources, setResources] = useState<Awaited<ReturnType<typeof inspectSourceRemoval>>>(),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [retry, setRetry] = useState(0);
  const running = useRef(false), mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    void inspectSourceRemoval(account.id)
      .then((value) => { if (!cancelled) setResources(value); })
      .catch((error: Error) => { if (!cancelled) setError(error.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [account.id, retry]);
  async function remove() {
    if (running.current || loading || !resources) return;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      await removeSource(account.id);
      if (mounted.current) onRemoved();
    } catch (error) {
      if (mounted.current) setError((error as Error).message);
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <ConfirmationDialog title={msg('移除书库')} subject={account.displayName} action={msg('移除书库及关联资料')} busy={busy} disabled={loading || !resources} error={error} onClose={() => { if (!running.current) onClose(); }} onConfirm={() => void remove()}
      meta={loading ? <span role="status">{msg('正在读取本机资料…')}</span> : resources && <><span>{msg('关联漫画：{0} 本', { '0': resources.comicCount })}</span><span>{msg('下载任务：{0} 个', { '0': resources.downloadTaskCount })}</span></>}
      extraActions={!resources && error && <button className="button secondary" disabled={busy || loading} onClick={() => setRetry((value) => value + 1)}>{msg('重试')}</button>}>
      <DialogNotice tone="danger" title={msg('此操作无法撤销')}>{msg('此书库的关联漫画、阅读记录与下载任务')}<p>{msg('此书库持有的原图、译图缓存和离线文件将一并清理。')}</p></DialogNotice>
      <DialogNotice tone="success" title={msg('保持不变')}>{msg('仅清理本机资料，远端书库文件保留。')}</DialogNotice>
    </ConfirmationDialog>
  );
}
