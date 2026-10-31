import {createContext, useContext, useEffect, useRef, useState, type ReactNode} from 'react';
import {App, Badge, Button, Popover, Tag} from 'antd';
import {BellOutlined} from '@ant-design/icons';
import {authError, errorText, fetchResponse} from './api';
import {href} from './ui';
export type InboxData = {total: number; counts: Record<string, number>; latest: Record<string, string | null>};
export const inboxViews: Record<string, string> = {translation: 'feedback', plugin: 'plugin-feedback', uninstall: 'uninstall-feedback', website: 'site-requests'};
export const inboxLabels: Record<string, string> = {translation: '翻译反馈', plugin: '插件反馈', uninstall: '卸载反馈', website: '网站适配'};
const InboxContext = createContext<{data?: InboxData; connected: boolean; error: string}>({connected: false, error: ''});
export const useInbox = () => useContext(InboxContext);

export function InboxProvider({children, onUnauthorized}: {children: ReactNode; onUnauthorized: (message: string) => void}) {
  const [data, setData] = useState<InboxData>(), [connected, setConnected] = useState(false), [error, setError] = useState('');
  const previous = useRef<InboxData | undefined>(undefined);
  const {notification, message} = App.useApp();
  useEffect(() => {
    const saved = () => {void message.success('操作已完成');};
    window.addEventListener('admin-mutation', saved);
    return () => window.removeEventListener('admin-mutation', saved);
  }, [message]);
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | undefined, failures = 0;
    function accept(next: InboxData | null) {
      if (!next) {stopped = true; onUnauthorized('管理员权限已失效，请重新登录。'); return;}
      if (previous.current) {
        const changed = Object.keys(next.latest).filter(kind => next.latest[kind] && next.latest[kind] !== previous.current!.latest[kind]);
        if (changed.length) {
          notification.info({title: '收到新反馈', key: 'new-feedback', description: changed.map(kind => inboxLabels[kind]).join('、'),
            duration: 8, actions: <Button onClick={() => {location.hash = href(inboxViews[changed[0]]); notification.destroy('new-feedback');}}>查看反馈</Button>});
          window.dispatchEvent(new Event('admin-inbox-changed'));
        }
      }
      previous.current = next; setData(next);
    }
    async function connect() {
      if (stopped || document.hidden) return;
      clearTimeout(timer);
      controller?.abort();
      const ownController = new AbortController();
      controller = ownController;
      try {
        const response = await fetchResponse('/v1/admin/workspace/events', {signal: ownController.signal});
        if (ownController.signal.aborted) return;
        if (!response.body) throw new Error('提醒连接不可用');
        setConnected(true); setError(''); failures = 0;
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let buffer = '';
        try {
          while (!stopped && !ownController.signal.aborted) {
            const result = await reader.read(); if (result.done) break;
            buffer += decoder.decode(result.value, {stream: true});
            if (buffer.length > 65536) throw new Error('提醒数据无效');
            let boundary: number;
            while ((boundary = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
              if (frame.startsWith('event: inbox\n')) accept(JSON.parse(frame.slice(frame.indexOf('data: ') + 6)));
            }
          }
        } finally {await reader.cancel().catch(() => undefined); reader.releaseLock();}
      } catch (failure) {
        if (ownController.signal.aborted || stopped) return;
        if (authError(failure)) {stopped = true; onUnauthorized(errorText(failure)); return;}
        failures += 1; setError('提醒连接中断，正在重连');
      } finally {
        if (controller === ownController) {
          setConnected(false);
          if (!stopped && !document.hidden) timer = setTimeout(() => void connect(), Math.min(30000, 1000 * 2 ** Math.min(failures, 5)));
        }
      }
    }
    const visibility = () => {clearTimeout(timer); if (document.hidden) controller?.abort(); else void connect();};
    document.addEventListener('visibilitychange', visibility); void connect();
    return () => {stopped = true; clearTimeout(timer); controller?.abort(); document.removeEventListener('visibilitychange', visibility);};
  }, [notification, onUnauthorized]);
  return <InboxContext.Provider value={{data, connected, error}}>{children}</InboxContext.Provider>;
}
export function InboxBell() {
  const {data, connected, error} = useInbox();
  return <Popover trigger="click" placement="bottomRight" title="反馈收件箱" content={<div className="inbox-popover">
    {Object.entries(inboxLabels).map(([kind, label]) => <a key={kind} href={href(inboxViews[kind])}><span>{label}</span><Tag>{data?.counts[kind] ?? '—'}</Tag></a>)}
    <p role="status" className="muted">{connected ? '新反馈将即时提醒' : error || '正在连接提醒…'}</p>
  </div>}><Badge count={data?.total || 0} overflowCount={99}><Button icon={<BellOutlined/>} aria-label={`反馈提醒${data ? `，${data.total} 条待处理` : ''}`}/></Badge></Popover>;
}
export function InboxCount() {const {data} = useInbox(); return data?.total ? <span className="nav-count">{data.total}</span> : null;}
