export const campaignEndpoint = '/v1/admin/quota-campaigns';
export const campaignStorageKey = 'nc-admin-quota-campaign:pending';
export type CampaignRules = {
  name: string; mode: 'classic' | 'redraw'; pages: number; audience: 'all' | 'existing' | 'new';
  starts_at: string | null; ends_at: string | null; validity_days: number | null;
};
export type QuotaCampaign = CampaignRules & {
  id: string; starts_at: string; enabled: boolean; version: number; created_at: string;
  created_by: string; awarded_users: number;
};
export type CampaignDraft = Omit<CampaignRules, 'pages' | 'validity_days' | 'starts_at' | 'ends_at'> & {
  pages: string; validity_days: string; starts_at: string; ends_at: string;
};
export type CampaignTimingDraft = Pick<CampaignDraft, 'ends_at' | 'validity_days'>;
export type CampaignDuration = Pick<CampaignRules, 'ends_at' | 'validity_days'> & {apply_to_existing: boolean; expected_version: number; note: string};
export type CampaignOperation = {id: string; summary: string} & (
  {method: 'PUT'; action?: never; body: CampaignRules} |
  {method: 'PATCH'; action?: never; body: {enabled: boolean; expected_version: number}} |
  {method: 'PATCH'; action: 'duration'; body: CampaignDuration}
);
export const audienceName = {all: '全部用户（含后续注册）', existing: '创建时已有用户', new: '创建后新用户'};
export function campaignDate(value: string): Date {
  return new Date(/(?:Z|[+-]\d\d:\d\d)$/i.test(value) ? value : `${value}Z`);
}
export function campaignState(campaign: QuotaCampaign, now = Date.now()): {text: string; tone: string} {
  if (campaign.ends_at && campaignDate(campaign.ends_at).getTime() <= now) return {text: '已结束', tone: ''};
  if (!campaign.enabled) return {text: '已暂停', tone: ''};
  return campaignDate(campaign.starts_at).getTime() > now ? {text: '待开始', tone: 'accent'} : {text: '发放中', tone: 'good'};
}
function integer(value: string, title: string, max: number): number {
  if (!/^\d+$/.test(value.trim()) || Number(value) < 1 || Number(value) > max) throw Error(`${title}需为 1–${max} 的整数。`);
  return Number(value);
}
export function localInputDate(value: string | null): string {
  if (!value) return '';
  const date = campaignDate(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
}
function date(value: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw Error('请填写有效的发放时间。');
  return parsed.toISOString();
}
export function campaignTiming(draft: CampaignTimingDraft, earliest: number) {
  const ends_at = date(draft.ends_at);
  if (ends_at && Date.parse(ends_at) <= earliest) throw Error('停止发放时间需晚于开始发放时间；新活动还需晚于现在。');
  return {ends_at, validity_days: draft.validity_days.trim() ? integer(draft.validity_days, '额度有效天数', 36500) : null};
}
export function campaignRules(draft: CampaignDraft, now = Date.now()): CampaignRules {
  const name = draft.name.trim();
  if (!name || name.length > 100) throw Error('活动名称需为 1–100 个字符。');
  const starts_at = date(draft.starts_at);
  return {name, mode: draft.mode, audience: draft.audience, pages: integer(draft.pages, '赠送页数', 1000000),
    starts_at, ...campaignTiming(draft, Math.max(now, starts_at ? Date.parse(starts_at) : now))};
}
export function newCampaignDraft(copy?: QuotaCampaign): CampaignDraft {
  return {name: copy ? `${copy.name.slice(0, 96)}（副本）` : '', mode: copy?.mode ?? 'classic', pages: copy ? String(copy.pages) : '',
    audience: copy?.audience ?? 'all', starts_at: '', ends_at: '', validity_days: copy?.validity_days ? String(copy.validity_days) : ''};
}
