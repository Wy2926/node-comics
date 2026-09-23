import { msg } from '../i18n/runtime';
import { Icon } from '../icons';
import { listSupportedSites } from '../sources/registry/sites';
import { SupportRequestForm } from './SupportRequestForm';
import './comic-sites.css';

export function ComicSites() {
  const sites = listSupportedSites();
  return <div className="nc-sites-page">
    <div className="nc-page-heading"><div><span className="nc-eyebrow">DISCOVER YOUR NEXT STORY</span><h1>{msg('漫画网站')}</h1><p>{msg('打开已适配的网站，把喜欢的故事带回书架。')}</p></div><span className="nc-sites-heading-icon" aria-hidden="true"><Icon name="globe" size={42}/><Icon name="spark" size={20}/></span></div>
    <div className="nc-sites-layout">
      <section aria-labelledby="nc-sites-title">
        <div className="nc-section-heading nc-sites-section-heading"><h2 id="nc-sites-title">{msg('已适配 {0} 个网站', { '0': sites.length })}</h2><span className="nc-muted"><Icon name="external" size={15}/>{msg('在新标签页打开')}</span></div>
        <ul className="nc-sites-grid">{sites.map((site, index) => <li key={site.key}>
          <a className="nc-site-card" href={site.url} target="_blank" rel="noopener noreferrer" aria-label={`${site.name} · ${msg('在新标签页打开')}`}>
            <div className="nc-site-card-top"><span className="nc-site-monogram" aria-hidden="true"><img src={site.icon} alt="" width={44} height={44} onError={event => { event.currentTarget.hidden = true; }}/><Icon name="globe" size={27}/></span><span className="nc-site-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span></div>
            <h3>{site.name}</h3><span className="nc-site-domain">{new URL(site.url).hostname.replace(/^www\./, '')}</span>
            <div className="nc-site-card-footer"><span><Icon name="check" size={15}/>{msg('已适配')}</span><Icon name="external" size={18}/></div>
          </a>
        </li>)}</ul>
        <p className="nc-sites-hint"><Icon name="info" size={19}/><span>{msg('进入漫画阅读页后，通过插件添加到书架。')}</span></p>
      </section>
      <section className="nc-site-request" aria-labelledby="nc-site-request-title">
        <div className="nc-site-request-icon"><Icon name="message" size={26}/></div>
        <h2 id="nc-site-request-title">{msg('申请适配网站')}</h2><p className="nc-site-request-intro">{msg('想读的网站还不在这里？告诉我们，无需登录。')}</p>
        <SupportRequestForm kind="website"/>
      </section>
    </div>
  </div>;
}
