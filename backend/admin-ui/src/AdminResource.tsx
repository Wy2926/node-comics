import {useCallback, useEffect, useRef, useState} from 'react';
import {authError, errorText, request} from './api';
import {Empty, labels, Table, time} from './ui';
import {billingStatus, money} from './billing';

export type Row = Record<string, unknown>;
export type DataPage = {items: Row[]; total: number; next_offset: number | null};
export type Column = {key: string; title: string; format?: 'time' | 'money' | 'currency'; formatter?: (value: unknown, row: Row) => string};
const vocabulary: Record<string, string> = {...labels, pending: '待处理', processing: '处理中', processed: '已处理',
  test: '测试环境', live: '正式环境', creem: 'Creem', stripe: 'Stripe',
  'control-worker': '控制工作进程', maintenance: '维护进程', oidc: '身份服务',
  created: '已创建', receiving: '接收中', uploaded: '已上传', validated: '已验证', consumed: '已使用'};
const semantic = new Set(['mode', 'status', 'environment', 'provider', 'role', 'kind']);

export function useAdminResource<T>(url: string | undefined, onUnauthorized: (message: string) => void) {
  const [data, setData] = useState<T>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  const lastUrl = useRef<string | undefined>(undefined);
  const reload = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    if (lastUrl.current !== url) {setData(undefined); lastUrl.current = url;}
    setError('');
    if (!url) {setBusy(false); return;}
    const controller = new AbortController();
    setBusy(true);
    request<T>(url, {signal: controller.signal}).then(result => {if (!controller.signal.aborted) setData(result);}).catch(failure => {
      if (controller.signal.aborted || failure.name === 'AbortError') return;
      if (authError(failure)) onUnauthorized(errorText(failure)); else setError(errorText(failure));
    }).finally(() => {if (!controller.signal.aborted) setBusy(false);});
    return () => controller.abort();
  }, [url, revision, onUnauthorized]);
  return {data, busy, error, reload};
}

export function valueText(value: unknown, format?: Column['format']) {
  if (value == null) return '—';
  if (format === 'time') return time(String(value));
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (format === 'money') return `¥${(Number(value) / 1000000).toFixed(6)}`;
  if (typeof value === 'number') return Number.isInteger(value) ? value.toLocaleString('zh-CN') : value.toFixed(3);
  return String(value);
}

export function columnText(row: Row, column: Column) {
  const value = row[column.key];
  if (column.formatter) return column.formatter(value, row);
  if (column.format === 'currency') return money(value == null ? null : Number(value), String(row.currency || 'usd'));
  if (semantic.has(column.key)) return vocabulary[String(value)] || billingStatus(String(value ?? ''));
  return valueText(value, column.format);
}

export function DataTable({rows, columns, empty = '暂无记录'}: {rows: Row[]; columns: Column[]; empty?: string}) {
  return rows.length ? <Table heads={columns.map(column => column.title)}>{rows.map((row, index) => <tr key={String(row.id ?? row.operation_key ?? index)}>
    {columns.map(column => {const text = columnText(row, column);
      return <td key={column.key}>{!column.formatter && /(?:^id$|_id$|_hash$|^sha256$|operation_key)/.test(column.key) ? <code className="id-value">{text}</code> : text}</td>;
    })}
  </tr>)}</Table> : <Empty>{empty}</Empty>;
}

export function ResourceError({error, stale}: {error: string; stale?: boolean}) {
  return error ? <p className="error" role="alert">{error} 请刷新重试。{stale && '当前数据可能已过时。'}</p> : null;
}
