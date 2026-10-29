import {memo, useMemo} from 'react';
import {formatDate, msg} from '../i18n/runtime';
import type {UiLocale} from '../i18n/locales';
import {Icon} from '../icons';
import type {listSupportedSites} from '../sources';
import {languageLabel} from '../types';
import {LanguageFlag} from './LanguageFlag';
import {PricingIcon, type siteLabels} from './SiteFilterControls';

type Props = {
  site: ReturnType<typeof listSupportedSites>[number] & {domain: string};
  favorite: boolean;
  onToggle: (key: string) => void;
  labels: ReturnType<typeof siteLabels>;
  locale: UiLocale;
};

/** Stable site metadata lets filtering and favorites reuse unchanged cards. */
export const ComicSiteCard = memo(function ComicSiteCard({site, favorite, onToggle, labels, locale}: Props) {
  const {contentTagLabels, accessTagLabels, pricingLabels} = labels;
  const date = useMemo(() => formatDate(site.adaptedOn + 'T00:00:00'), [site.adaptedOn, locale]);
  return <li className="nc-site-card" data-site-key={site.key}>
    <a className="nc-site-card-link" href={site.url} target="_blank" rel="noopener noreferrer" aria-label={`${site.name} · ${pricingLabels[site.pricing].label}${site.isAdult ? ' · 18+ · ' + contentTagLabels.adult : ''}${site.isRaw ? ' · ' + msg('生肉') : ''} · ${msg('在新标签页打开')}`}>
      <span className={'nc-site-pricing-badge nc-site-pricing-' + site.pricing} role="img" title={pricingLabels[site.pricing].description} aria-label={pricingLabels[site.pricing].description}><PricingIcon pricing={site.pricing}/></span>
      <div className="nc-site-card-top"><span className="nc-site-monogram" aria-hidden="true"><img src={site.icon} alt="" width={44} height={44} loading="lazy" decoding="async" onError={event => {event.currentTarget.hidden = true;}}/><Icon name="globe" size={27}/></span><span className="nc-site-languages">{site.primaryLanguages.map(language => <span key={language} role="img" aria-label={languageLabel(language)} title={languageLabel(language)}><LanguageFlag language={language}/></span>)}</span></div>
      <h3>{site.name}</h3><span className="nc-site-domain">{site.domain}</span>
      <div className="nc-site-tags">{site.isAdult && <span className="nc-site-adult"><bdi>18+</bdi> {contentTagLabels.adult}</span>}{site.isRaw && <span className="nc-site-raw" title={msg('以未翻译的日语或韩语原文内容为主')}>{msg('生肉')}</span>}{site.contentTags.map(tag => <span key={tag}>{contentTagLabels[tag]}</span>)}</div>
    </a>
    <div className="nc-site-card-footer"><span className="nc-site-adapted">
      <span><span className="nc-site-supported"><Icon name="check" size={15}/>{msg('已适配')}</span>{site.accessTags?.map(tag => <span key={tag} className={'nc-site-access nc-site-access-' + tag} title={accessTagLabels[tag].description} aria-label={accessTagLabels[tag].description}>{accessTagLabels[tag].label}</span>)}</span>
      <time dateTime={site.adaptedOn} title={msg('适配日期')}>{date}</time>
    </span>
      <button type="button" className="nc-site-favorite" aria-pressed={favorite}
        aria-label={`${msg('收藏网站')} · ${site.name}`} title={favorite ? msg('取消收藏网站') : msg('收藏网站')}
        onClick={() => onToggle(site.key)}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill={favorite ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true"><path d="m12 3 2.8 5.7 6.3.9-4.5 4.4 1 6.2-5.6-3-5.6 3 1-6.2-4.5-4.4 6.3-.9Z"/></svg>
      </button>
    </div>
  </li>;
});
