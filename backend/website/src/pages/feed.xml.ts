import type { APIRoute } from 'astro';
import { releases } from '../data/content';
import { absolute } from '../data/site';
const xml = (text: string) => text.replace(/[<>&"']/g, value => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[value]!);
export const GET: APIRoute = () => new Response(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>NodeLane Comics 更新日志</title><link>${absolute('/changelog/')}</link><description>漫画翻译与阅读体验的持续更新</description><language>zh-CN</language>${releases.map(release => `<item><title>${xml(release.title)}</title><link>${absolute(`/changelog/#release-${release.date}`)}</link><guid>${absolute(`/changelog/#release-${release.date}`)}</guid><pubDate>${new Date(`${release.date}T00:00:00+08:00`).toUTCString()}</pubDate><description>${xml(release.items.join('；'))}</description></item>`).join('')}</channel></rss>`, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
