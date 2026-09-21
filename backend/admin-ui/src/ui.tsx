import type {ReactNode} from 'react';

export const labels: Record<string, string> = {
  classic: '常规翻译', redraw: 'AI 重绘', awaiting_upload: '待上传', validating_upload: '校验上传',
  queued: '排队中', running: '执行中', outcome_unknown: '结果待核实', unknown_released: '未知结果已释放',
  succeeded: '已完成', no_text: '无文字', failed: '失败', cancelled: '已取消', ready: '待执行', waiting: '等待依赖',
  expired: '租约已过期', realtime: '实时', preload: '预存', page: '整页执行与交付', analyze: '文字检测 / OCR', text: '文本翻译',
  inpaint: '背景修复', render: '嵌字与交付', validate_upload: '上传校验', reserved: '已预占', charged: '已结算',
  released: '已释放', reported: '已报告', unknown: '待核实', estimated: '估算', active: '全部在途', attention: '需要关注',
  settled: '已结算', included: '权益内包含', free: '无需扣页',
  classic_daily: '常规每日额度', classic_unlimited: '常规不限量', redraw_monthly: '重绘月度额度', redraw_grant: '重绘赠送额度',
  daily: '每日额度', membership: '运营会员', grant: '限时赠送', subscription: '付费订阅', reconcile: '人工核实',
};
export const label = (value: string | null | undefined) => value ? labels[value] || value : '—';
export const number = (value: number | undefined) => (value || 0).toLocaleString('zh-CN');
export const time = (value: string | null | undefined) => value ? new Date(/(?:Z|[+-]\d\d:\d\d)$/i.test(value) ? value : `${value}Z`).toLocaleString('zh-CN', {hour12: false}) : '—';
export function duration(value: number | null | undefined): string {
  if (value == null) return '—';
  if (value < 60) return `${value.toFixed(1)} 秒`;
  if (value < 3600) return `${Math.floor(value / 60)} 分 ${Math.floor(value % 60)} 秒`;
  if (value < 86400) return `${Math.floor(value / 3600)} 小时 ${Math.floor(value % 3600 / 60)} 分`;
  return `${Math.floor(value / 86400)} 天 ${Math.floor(value % 86400 / 3600)} 小时`;
}
export function Badge({value}: {value: string | null}) {
  const style = ['succeeded', 'no_text'].includes(value || '') ? 'good'
    : ['failed', 'expired', 'outcome_unknown', 'unknown_released'].includes(value || '') ? 'warn'
    : ['running', 'realtime'].includes(value || '') ? 'accent' : '';
  return <span className={`badge ${style}`}>{label(value)}</span>;
}
export const href = (view: string, params: Record<string, string> = {}) => `#${view}${Object.keys(params).length ? '?' + new URLSearchParams(params) : ''}`;
export function Jump({view, params, children}: {view: string; params?: Record<string, string>; children: ReactNode}) {
  return <a className="text-link" href={href(view, params)}>{children}</a>;
}
export function Empty({children}: {children: ReactNode}) {
  return <div className="empty"><span aria-hidden="true">◇</span><h3>{children}</h3><p>数据更新后会显示在这里。</p></div>;
}
export function Stat({title, value, note, tint = false}: {title: string; value: string; note: string; tint?: boolean}) {
  return <article className={`stat ${tint ? 'tint' : ''}`}><p>{title}</p><strong>{value}</strong><span>{note}</span></article>;
}
export function Table({heads, children}: {heads: string[]; children: ReactNode}) {
  return <div className="table-scroll"><table><thead><tr>{heads.map(h => <th scope="col" key={h}>{h}</th>)}</tr></thead><tbody>{children}</tbody></table></div>;
}
export function Pagination({total, count, offset, next, onPage}: {total: number; count: number; offset: number; next: number | null; onPage: (offset: number) => void}) {
  return <div className="pagination"><span>共 {number(total)} 条{count ? ` · 第 ${number(offset + 1)}–${number(offset + count)} 条` : ''}</span><div>
    <button className="secondary" disabled={!offset} onClick={() => onPage(Math.max(0, offset - 25))}>上一页</button>
    <button className="secondary" disabled={next == null} onClick={() => next != null && onPage(next)}>下一页</button>
  </div></div>;
}
