import type { APIRoute } from 'astro';
import { dictionaries, locales, prefixes, localPath, type Locale } from '../../i18n';
import { absolute } from '../../data/site';
export function getStaticPaths() { return locales.filter(locale=>locale!=='zh-CN').map(locale=>({params:{locale:prefixes[locale]},props:{locale}})); }
const xml=(value:string)=>value.replace(/[<>&"']/g,char=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'})[char]!);
export const GET: APIRoute = ({props}) => {
  const locale=props.locale as Locale;
  const {ui,documents}=dictionaries[locale];
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>NodeLane Comics ${xml(ui.changelog)}</title><link>${absolute(localPath('/changelog/',locale))}</link><description>${xml(ui.changelogDescription)}</description><language>${locale}</language>${documents.releases.map(release=>`<item><title>${xml(release.title)}</title><link>${absolute(localPath(`/changelog/#release-${release.id ?? release.date}`,locale))}</link><guid>${absolute(localPath(`/changelog/#release-${release.id ?? release.date}`,locale))}</guid><pubDate>${new Date(`${release.date}T00:00:00+08:00`).toUTCString()}</pubDate><description>${xml(release.items.join('; '))}</description></item>`).join('')}</channel></rss>`,{headers:{'Content-Type':'application/rss+xml; charset=utf-8'}});
};
