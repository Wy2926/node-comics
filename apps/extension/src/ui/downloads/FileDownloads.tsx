import { useEffect, useState } from 'react';
import { msg } from '../../i18n/runtime';
import { Icon } from '../../icons';
import { ConfirmationDialog, DialogNotice } from '../ConfirmationDialog';
import { Thumbnail } from '../../reader/Images';
import { coverReference } from '../../comics/application/library-service';
import {
  clearRemoteFileDownload,
  pauseRemoteFileDownload,
  resumeRemoteFileDownload,
  type FileDownloadView,
} from '../../comics/acquisition/files';
import type { BookDownloadsController } from './useBookDownloads';

export function FileDownloadRows({
  controller,
  onRead,
}: {
  controller: BookDownloadsController;
  onRead: (comicId: string) => void;
}) {
  if (!controller.files.length) return null;
  return (
    <section aria-label={msg('完整文件下载')}>
      <h2>{msg('完整文件下载')}</h2>
      <div className="nc-download-books">
        {controller.files.map((file) => (
          <FileRow
            key={file.intent.id}
            file={file}
            onRead={onRead}
            onChanged={controller.refresh}
          />
        ))}
      </div>
    </section>
  );
}
function FileRow({
  file,
  onRead,
  onChanged,
}: {
  file: FileDownloadView;
  onRead: (comicId: string) => void;
  onChanged: () => void;
}) {
  const { intent, comic } = file,
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState<'resume' | 'clear'>();
  const running = intent.status === 'running' || intent.status === 'queued',
    complete = intent.status === 'complete';
  const label = complete
    ? msg('已缓存')
    : intent.status === 'queued'
      ? msg('等待缓存')
      : intent.status === 'running'
        ? msg('正在保存完整文件')
        : intent.status === 'clearing'
          ? msg('正在清理离线内容…')
          : intent.status === 'failed'
            ? msg('需要处理')
            : msg('已暂停');
  async function act(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await action();
      setConfirmation(undefined);
      onChanged();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <article className="nc-download-book" data-file-download-id={intent.id}>
        <button
          className="nc-download-cover"
          disabled={!comic}
          onClick={() => {
            if (comic) onRead(comic.id);
          }}
          aria-label={msg('打开漫画 {0}', { '0': intent.title })}
        >
          {comic ? (
            <Thumbnail blobKey={coverReference(comic)} alt="" />
          ) : (
            <Icon name="book" size={40} />
          )}
        </button>
        <div className="nc-download-info">
          <div className="nc-download-title">
            <h2>
              {comic ? (
                <button onClick={() => onRead(comic.id)}>{intent.title}</button>
              ) : (
                intent.title
              )}
            </h2>
            <span
              className="nc-download-status"
              data-state={intent.status}
              data-tone={complete ? 'complete' : running ? 'active' : 'attention'}
            >
              {label}
            </span>
          </div>
          <p className="nc-muted">
            {complete
              ? msg('下载完成，可开始阅读')
              : msg('已保存 {0} MB', { '0': (intent.bytes / 1024 ** 2).toFixed(1) })}
            {intent.totalBytes !== undefined &&
              !complete &&
              ' / ' + (intent.totalBytes / 1024 ** 2).toFixed(1) + ' MB'}
          </p>
          {running && (
            <div className="nc-download-progress">
              {intent.totalBytes ? (
                <progress
                  aria-label={msg('完整文件下载')}
                  max={intent.totalBytes}
                  value={intent.bytes}
                />
              ) : (
                <progress aria-label={msg('完整文件下载')} />
              )}
            </div>
          )}
          {(intent.error || error) && (
            <p className="nc-download-feedback" role="alert">
              {error || intent.error}
            </p>
          )}
          {intent.retryAt !== undefined && intent.retryAt > Date.now() && (
            <p className="nc-muted">
              {msg('来源暂时限制请求，请在 {0} 后继续。', {
                '0': new Date(intent.retryAt).toLocaleTimeString(),
              })}
            </p>
          )}
        </div>
        <div className="nc-download-actions">
          <div className="nc-download-controls">
            {complete && comic ? (
              <button className="button primary small" onClick={() => onRead(comic.id)}>
                {msg('开始阅读')}
              </button>
            ) : running ? (
              <button
                className="button secondary small"
                disabled={busy}
                onClick={() =>
                  void act(() => pauseRemoteFileDownload(intent.id, intent.generation))
                }
              >
                {msg('暂停缓存')}
              </button>
            ) : (
              intent.status !== 'clearing' && (
                <button
                  className="button primary small"
                  disabled={busy}
                  onClick={() => setConfirmation('resume')}
                >
                  {msg('重新下载')}
                </button>
              )
            )}
            <button
              className="button secondary small"
              disabled={busy}
              onClick={() => setConfirmation('clear')}
            >
              {complete ? msg('清除离线内容') : msg('取消缓存')}
            </button>
          </div>
          <div className="nc-download-size">
            <span>{msg('离线占用')}</span>
            <strong>
              {(
                (complete ? (intent.totalBytes ?? intent.bytes) : intent.bytes) /
                1024 ** 2
              ).toFixed(1)}{' '}
              MB
            </strong>
          </div>
        </div>
      </article>
      {confirmation && (
        <ConfirmationDialog
          title={confirmation === 'resume' ? msg('重新下载') : complete ? msg('清除离线内容') : msg('取消缓存')}
          subject={intent.title}
          meta={confirmation === 'resume' ? intent.totalBytes !== undefined && msg('文件大小约 {0} MB', {'0': (intent.totalBytes / 1024 ** 2).toFixed(1)}) : msg('已保留 {0}', {'0': ((complete ? intent.totalBytes ?? intent.bytes : intent.bytes) / 1024 ** 2).toFixed(1) + ' MB'})}
          action={confirmation === 'resume' ? msg('重新下载') : complete ? msg('清除离线内容') : msg('取消缓存')}
          icon={confirmation === 'resume' ? 'refresh' : 'trash'} danger={confirmation !== 'resume'}
          busy={busy} error={error} onClose={() => setConfirmation(undefined)}
          onConfirm={() => void act(() => confirmation === 'resume' ? resumeRemoteFileDownload(intent.id, intent.generation) : clearRemoteFileDownload(intent.id, intent.generation))}
        >
          {confirmation === 'resume' ? <DialogNotice title={msg('重新下载')}>{msg('下载中断后需要从头重新下载。')}<p>{msg('请保持此插件页打开，可切换到其他标签页。')}</p></DialogNotice> : <DialogNotice tone="danger" title={msg('将会移除')}>{msg('完整离线文件；再次阅读可能需要重新下载。')}</DialogNotice>}
          <DialogNotice tone="success" title={msg('保持不变')}>{msg('漫画与阅读记录')}</DialogNotice>
        </ConfirmationDialog>
      )}
    </>
  );
}
export function FileDownloadPrompt({ controller }: { controller: BookDownloadsController }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    setError('');
  }, [controller.filePrompt]);
  const request = controller.filePrompt;
  if (!request) return null;
  return (
    <ConfirmationDialog
      title={msg('下载后阅读')} subject={request.plan.publication.title} action={msg('下载后阅读')} icon="download" danger={false}
      meta={request.plan.size !== undefined && msg('文件大小约 {0} MB', { '0': (request.plan.size / 1024 ** 2).toFixed(1) })}
      busy={busy} error={error} onClose={() => controller.closeFilePrompt()}
      onConfirm={() => {
        if (busy) return;
        setBusy(true);
        setError('');
        void controller.confirmFile().catch((error) => setError(error.message)).finally(() => setBusy(false));
      }}
    >
      <DialogNotice tone="success" title={msg('完整文件下载')}>{msg('下载完整文件后即可离线阅读。')}</DialogNotice>
      <DialogNotice title={msg('下载后阅读')}>{msg('请保持此插件页打开，可切换到其他标签页。')}<p>{msg('下载中断后需要从头重新下载。')}</p></DialogNotice>
    </ConfirmationDialog>
  );
}
