import {quotaPurchaseCopy} from '../i18n/quota-purchase';
import {amountParts,type BillingOffer} from '../lib/billing';
import CheckoutButton,{type CheckoutCopy} from './CheckoutButton';
import PriceAmount from './PriceAmount';

const iconPaths={
  pages:'M8 3h11v14H8z M5 7v14h11 M11 7h5 M11 11h5',
  tier:'m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z m-4 9 3 3 5-6',
  clock:'M12 8v4l3 2 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  bolt:'m13 2-9 12h7l-1 8 10-12h-7z',
};
function QuotaIcon({kind}:{kind:keyof typeof iconPaths}){
  return <svg className="quota-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={iconPaths[kind]}/></svg>;
}

export default function QuotaOffers({locale,offers,blocked=false,preview=false,accountHref,checkoutCopy}:{locale:string;offers:BillingOffer[];blocked?:boolean;preview?:boolean;accountHref:string;checkoutCopy:CheckoutCopy}){
  const copy=quotaPurchaseCopy(locale);
  const visible=offers.filter(offer=>offer.interval==='once'&&(preview||offer.channels.length>0));
  if(!visible.length)return null;
  const [beforePages,afterPages]=copy.pages.split('{0}');
  return <section className="quota-offers" aria-label={copy.title}>
    <header className="quota-offers-heading"><h2>{copy.title}</h2></header>
    <div className="quota-offer-grid">{visible.map(offer=><article className="quota-offer" key={offer.id}>
      <header className="quota-offer-heading"><h3>{offer.name}</h3><span className="quota-page-mark"><QuotaIcon kind="pages"/></span></header>
      <div className="quota-offer-quantity">{beforePages&&<span>{beforePages}</span>}<strong>{(offer.quota_pages??0).toLocaleString(locale)}</strong><span>{afterPages}</span></div>
      <div className="quota-offer-price"><bdi><PriceAmount parts={amountParts(offer,locale)}/></bdi><span className="quota-purchase-kind">{copy.oneTime}</span></div>
      <ul className="quota-offer-features">
        {offer.service_plan_id&&<li className="quota-tier"><QuotaIcon kind="tier"/><span>{copy.service.replace('{0}',offer.service_plan_id==='lite'?'Lite':offer.service_plan_id==='plus'?'PLUS':offer.service_plan_id==='pro'?'Pro':offer.service_plan_id)}</span></li>}
        <li><QuotaIcon kind="clock"/><span>{offer.quota_validity_days==null?copy.noExpiry:copy.validity.replace('{0}',offer.quota_validity_days.toLocaleString(locale))}</span></li>
        {offer.hourly_image_limit!=null&&<li><QuotaIcon kind="bolt"/><span>{copy.hourly.replace('{0}',offer.hourly_image_limit.toLocaleString(locale))}</span></li>}
      </ul>
      <div className="quota-offer-action">{offer.channels.length?<CheckoutButton priceId={offer.id} accountHref={accountHref} disabled={blocked} showDisclosure={false} label={copy.action} copy={{...checkoutCopy,renewal:copy.terms,retry:copy.retry,retryHint:copy.retryHint}}/>:<button className="button" disabled>{copy.action}</button>}</div>
    </article>)}</div>
    <div className="quota-offer-policy">
      <ul className="quota-offer-notes">{[copy.usage,copy.subscription,copy.validityStart].map(note=><li key={note}><span className="ui-icon icon-check" aria-hidden="true"/><span>{note}</span></li>)}</ul>
      <p className="quota-offer-legal">{copy.tax} {checkoutCopy.before}<a className="text-link" href={accountHref.replace(/account\/$/,'refund/')}>{checkoutCopy.refund}</a>{copy.terms}</p>
    </div>
  </section>;
}
