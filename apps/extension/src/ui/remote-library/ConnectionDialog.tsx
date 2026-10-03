import { useEffect, useRef, useState } from 'react';
import { msg } from '../../i18n/runtime';
import type { SourceAccount } from '../../comics/sources/contracts';
import type { SourceConnection } from '../../comics/domain';
import {
  connectRemoteLibrary,
  listRemoteProviders,
  remoteLibraryConfiguration,
} from '../../comics/application/remote-library-service';
import { Modal } from '../components';
import { Select } from '../Select';

/** Provider-owned fields; the UI never reads the provider's private credential store. */
export function ConnectionDialog({
  account,
  onClose,
  onConnected,
}: {
  account?: SourceAccount;
  onClose: () => void;
  onConnected: (connection: SourceConnection) => void;
}) {
  const providers = listRemoteProviders(),
    [providerId, setProviderId] = useState(account?.provider ?? providers[0]?.id ?? '');
  const provider = providers.find((value) => value.id === providerId);
  const [values, setValues] = useState<Record<string, string>>({
    name: account?.displayName ?? '',
  });
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(!!account),
    [initial, setInitial] = useState<Record<string, string>>(),
    [error, setError] = useState(''),
    [configurationRetry, setConfigurationRetry] = useState(0),
    request = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    let cancelled = false;
    const defaults = Object.fromEntries(
      (provider?.fields ?? []).filter((field) => field.type === 'select').map((field) => [field.id, field.options?.[0]?.value ?? '']),
    );
    setError('');
    setInitial(undefined);
    if (!account) {
      setValues({ ...defaults, name: '' });
      setLoading(false);
      return;
    }
    setLoading(true);
    void remoteLibraryConfiguration(account.id)
      .then((configuration) => {
        if (cancelled) return;
        const original = { ...defaults, ...configuration };
        setValues(original);
        setInitial(original);
      })
      .catch((error: Error) => { if (!cancelled) setError(error.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [account?.id, providerId, configurationRetry]);
  const close = () => {
    request.current?.abort();
    setValues({});
    onClose();
  };
  async function connect() {
    if (!provider || request.current || loading || account && !initial) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      const connection = await connectRemoteLibrary(
        provider.id,
        values,
        account?.id,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      setValues({});
      onConnected(connection);
    } catch (error) {
      if (!controller.signal.aborted) setError((error as Error).message);
    } finally {
      if (request.current === controller) {
        request.current = undefined;
        if (!controller.signal.aborted) setBusy(false);
      }
    }
  }
  const editable = account?.status === 'connected';
  const credentialsAvailable = !!account && account.status !== 'disconnected';
  const fields = provider?.fields.filter((field) => !field.showWhen || field.showWhen.values.includes(values[field.showWhen.field] ?? '')) ?? [];
  const preserve = (field: (typeof fields)[number]) =>
    credentialsAvailable && (field.sensitive || field.type === 'url') && (!field.showWhen || initial?.[field.showWhen.field] === values[field.showWhen.field]);
  function setField(id: string, value: string) {
    setValues((previous) => {
      const next = { ...previous, [id]: value };
      for (const field of provider?.fields ?? [])
        if (field.sensitive && field.showWhen?.field === id) delete next[field.id];
      return next;
    });
  }
  return (
    <Modal title={account ? editable ? msg('编辑书库') : msg('重新连接书库') : msg('连接远程书库')} onClose={close} className="nc-connection-dialog">
      <form
        className="nc-stack"
        onSubmit={(event) => {
          event.preventDefault();
          void connect();
        }}
      >
        {providers.length > 1 && !account && (
          <label className="field">
            {msg('协议')}
            <Select
              value={providerId}
              disabled={busy}
              onChange={(event) => {
                setProviderId(event.target.value);
                setValues({});
                setError('');
              }}
            >
              {providers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </Select>
          </label>
        )}
        <p className="nc-muted">{msg('连接后浏览远程目录，打开时才加入我的漫画。')}</p>
        {loading && <p role="status" className="nc-muted">{msg('正在读取来源连接…')}</p>}
        {!loading && (!account || initial) && fields.map((field) => (
          <label className="field" key={field.id}>
            {field.label}
            {field.type === 'select' ? (
              <Select
                value={values[field.id] ?? field.options?.[0]?.value ?? ''}
                disabled={busy || !!account}
                onChange={(event) => setField(field.id, event.target.value)}
              >
                {field.options?.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            ) : (
              <input
                type={field.type}
                required={field.required && !preserve(field)}
                value={values[field.id] ?? ''}
                placeholder={preserve(field) ? msg('留空表示不修改') : field.placeholder}
                disabled={busy}
                maxLength={field.type === 'url' || field.type === 'password' ? 8192 : 256}
                autoComplete={field.type === 'password' ? 'new-password' : 'off'}
                spellCheck={false}
                onChange={(event) => setField(field.id, event.target.value)}
              />
            )}
            {field.description && <small className="nc-muted">{field.description}</small>}
          </label>
        ))}
        {account && fields.some((field) => field.sensitive) && (
          <p className="nc-connection-auth-note">{msg('授权信息留空时保留原设置；已断开的书库需要重新填写授权信息。')}</p>
        )}
        {account && <p className="nc-muted">{msg('更换服务器或账户时，请新增书库连接。')}</p>}
        <p className="nc-muted">{msg('书库凭据仅保存在当前浏览器，不会上传至 NodeLane。')}</p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="nc-inline">
          <button className="button primary" type="submit" disabled={busy || loading || !provider || !!account && !initial}>
            {busy ? msg('正在连接…') : editable ? msg('保存修改') : msg('连接并浏览')}
          </button>
          {account && !initial && error && <button className="button secondary" type="button" disabled={loading} onClick={() => setConfigurationRetry((value) => value + 1)}>{msg('重试')}</button>}
          <button className="button secondary" type="button" onClick={close}>
            {msg('取消')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
