import {Drawer} from 'antd';
import {useCallback, useEffect, useRef, useState, type ReactNode} from 'react';
import {authError, errorText, request} from './api';
import {billingStatus} from './billing';

export function BillingBadge({status, subscription = false, binding = false}: {status: string; subscription?: boolean; binding?: boolean}) {
  const tone = ['active', 'paid', 'completed', 'succeeded', 'trialing'].includes(status) ? 'good' : ['failed', 'unknown', 'outcome_unknown', 'disputed', 'past_due', 'unpaid'].includes(status) ? 'warn' : status === 'pending' ? 'accent' : '';
  return <span className={`badge ${tone}`}>{binding ? ({active: '已启用', archived: '已停用', draft: '待验证'} as Record<string, string>)[status] ?? billingStatus(status) : subscription && status === 'active' ? '订阅生效中' : billingStatus(status)}</span>;
}

export function useBillingResource<T>(url: string, onUnauthorized: (message: string) => void) {
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const reload = useCallback(async () => {
    const controller = new AbortController(); controllerRef.current?.abort(); controllerRef.current = controller;
    setLoading(true); setError('');
    try {
      const result = await request<T>(url, {signal: controller.signal});
      if (!controller.signal.aborted) setData(result);
    } catch (failure) {
      if (controller.signal.aborted) return;
      if (authError(failure)) onUnauthorized(errorText(failure)); else setError(errorText(failure));
    } finally {if (controllerRef.current === controller) {controllerRef.current = undefined; setLoading(false);}}
  }, [url, onUnauthorized]);
  useEffect(() => {setData(undefined); void reload(); return () => controllerRef.current?.abort();}, [reload]);
  return {data, loading, error, reload};
}

export function BillingDialog({title, onClose, busy = false, children}: {title: string; onClose: () => void; busy?: boolean; children: ReactNode}) {
  return <Drawer open title={title} onClose={onClose} closable={!busy} keyboard={!busy} maskClosable={false}
    rootClassName="billing-drawer" styles={{wrapper: {width: 'min(1000px, 94vw)'}}}>
    <div className="dialog-content">{children}</div>
  </Drawer>;
}
