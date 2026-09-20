export const billingEndpoint = '/v1/admin/billing';
export type BillingProvider = 'stripe' | 'creem';
export type BillingEnvironment = 'test' | 'live';
export type BillingRevision = {id: string; plan_id: string; version: number; name: string; monthly_redraw_pages: number; trial_days: number; trial_redraw_pages: number};
export type BillingBinding = {id: string; price_id: string; provider: BillingProvider; environment: BillingEnvironment; product_id: string; provider_price_id: string | null; trial_product_id: string | null; status: string; created_at: string};
export type BillingPrice = BillingRevision & {plan_revision_id: string; currency: string; unit_amount: number; interval: 'month' | 'year'; environment: BillingEnvironment; status: string; bindings: BillingBinding[]};
export type BillingProduct = {id: string; name: string; revisions: BillingRevision[]; prices: BillingPrice[]};
export type BillingChannel = {provider: BillingProvider; enabled: boolean; environment: BillingEnvironment; credential_configured?: boolean; webhook_configured?: boolean; checkout_enabled?: boolean};
export type BillingCatalog = {products: BillingProduct[]; channels: BillingChannel[]};
export type BillingOrder = {id: string; owner_id: string; owner_name: string; provider: BillingProvider; environment: BillingEnvironment; checkout_id: string | null; subscription_id: string | null; price_id: string | null; binding_id: string | null; external_id: string | null; kind: string; status: string; currency: string | null; subtotal: number | null; total: number | null; created_at: string; updated_at: string; paid_at: string | null; error_code: string | null; product_name: string | null; interval: string | null};
export type BillingOrderPage = {items: BillingOrder[]; total: number; page: number; page_size: number};
export type BillingNotification = {id: string; event_type: string; status: string; attempts: number; error_code: string | null; occurred_at: string; received_at: string; processed_at: string | null; next_attempt_at: string | null};
export type BillingOrderDetail = {order: BillingOrder; price: BillingPrice | null; checkout: {id: string; status: string; session_id: string | null; trial: boolean; created_at: string; expires_at: string | null; error_code: string | null} | null; subscription: {id: string; status: string; next_billed_at: string | null; cancel_at: string | null; trial_starts_at: string | null; trial_ends_at: string | null; paid_starts_at: string | null; paid_ends_at: string | null} | null; transitions: {id: string; source: string; event_id: string | null; from_status: string | null; to_status: string; detail: Record<string, unknown>; created_at: string}[]; events: BillingNotification[]; events_total: number; events_limit: number};

export const providerName = (value: string) => ({stripe: 'Stripe', creem: 'Creem'}[value] ?? value);
export const environmentName = (value: string) => value === 'live' ? '正式环境' : '测试环境';
export const intervalName = (value: string | null) => value === 'year' ? '年付' : value === 'month' ? '月付' : '—';
const statusLabels: Record<string, string> = {draft: '草稿', active: '在售', archived: '已停售', creating: '正在创建', created: '已创建', pending: '待付款', pending_payment: '待付款', checkout_created: '待付款', checkout_completed: '结账完成', processing: '处理中', paid: '已支付', succeeded: '已完成', completed: '已完成', failed: '失败', cancelled: '已取消', canceled: '已取消', expired: '已过期', refunded: '已退款', partially_refunded: '部分退款', disputed: '有争议', unknown: '结果待核实', outcome_unknown: '结果待核实', trialing: '试用中', past_due: '逾期未付', unpaid: '未支付', paused: '已暂停', incomplete: '未完成', incomplete_expired: '未完成已过期'};
export const billingStatus = (value: string | null | undefined) => value ? statusLabels[value] ?? value : '—';
export const orderKind = (value: string) => ({checkout: '首次订阅', initial: '首次订阅', subscription: '订阅付款', renewal: '订阅续费', payment: '付款', refund: '退款', trial: '试用订阅'}[value] ?? value);
export function currencyDigits(currency: string) {return new Intl.NumberFormat('en', {style: 'currency', currency: currency.toUpperCase()}).resolvedOptions().maximumFractionDigits ?? 2;}
export function money(amount: number | null | undefined, currency: string | null | undefined) {
  if (amount == null || !currency) return '—';
  try {return new Intl.NumberFormat('zh-CN', {style: 'currency', currency: currency.toUpperCase(), currencyDisplay: 'code'}).format(amount / 10 ** currencyDigits(currency));}
  catch {return `${currency.toUpperCase()} ${amount}`;}
}
export function priceAmount(amount: number, currency: string) {return (amount / 10 ** currencyDigits(currency)).toFixed(currencyDigits(currency));}
export function billingDate(value: string) {return new Date(/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? value : `${value}Z`);}
export const billingTime = (value: string | null | undefined) => value ? billingDate(value).toLocaleString('zh-CN', {hour12: false}) : '—';
export function minorAmount(value: string, currency: string) {
  const digits = currencyDigits(currency), normalized = value.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) throw Error('请输入有效的价格金额。');
  const [whole, fraction = ''] = normalized.split('.');
  if (fraction.length > digits) throw Error(`${currency.toUpperCase()} 最多支持 ${digits} 位小数。`);
  const amount = Number(whole) * 10 ** digits + Number(fraction.padEnd(digits, '0'));
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 100000000) throw Error('价格金额超出允许范围。');
  return amount;
}
