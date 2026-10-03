import { useEffect, useRef, useState } from 'react';
import { msg } from '../../i18n/runtime';
import { Icon } from '../../icons';
import type { SourceAccount } from '../../comics/sources/contracts';
import { inspectSourceRemoval, removeSource } from '../../comics/application/source-lifecycle';
import { Modal } from '../components';
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
    <Modal title={msg('移除书库')} onClose={() => { if (!running.current) onClose(); }} className="nc-connection-removal">
      <div className="nc-connection-removal-warning">
        <Icon name="trash" size={28} />
        <div>
          <h3>{msg('此操作无法撤销')}</h3>
          <p>{msg('将移除《{0}》及其全部关联漫画、阅读记录和下载任务。', { '0': account.displayName })}</p>
          <p>{msg('此书库持有的原图、译图缓存和离线文件将一并清理。')}</p>
        </div>
      </div>
      {loading ? (
        <p role="status" className="nc-muted">{msg('正在读取本机资料…')}</p>
      ) : resources && (
        <div className="nc-connection-removal-counts">
          <span>{msg('关联漫画：{0} 本', { '0': resources.comicCount })}</span>
          <span>{msg('下载任务：{0} 个', { '0': resources.downloadTaskCount })}</span>
        </div>
      )}
      <p className="nc-muted">{msg('仅清理本机资料，远端书库文件保留。')}</p>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="nc-inline">
        <button className="button danger" disabled={busy || loading || !resources} onClick={() => void remove()}>
          <Icon name="trash" size={18} />
          {busy ? msg('正在移除书库…') : msg('移除书库及关联资料')}
        </button>
        {!resources && error && <button className="button secondary" disabled={busy || loading} onClick={() => setRetry((value) => value + 1)}>{msg('重试')}</button>}
        <button className="button secondary" disabled={busy} onClick={onClose}>{msg('取消')}</button>
      </div>
    </Modal>
  );
}
