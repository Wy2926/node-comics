import {publishedPlus} from '../data/published-plus';
import {billingCopy} from '../lib/billing';
import {pricingCopy,publishedPricingCopy} from '../lib/pricing';

export type PurchaseAvailability = 'loading' | 'unavailable' | 'error';

export default function PublishedPlusPricing({locale}:{locale:string}) {
  const copy=billingCopy(locale),published=publishedPricingCopy(locale);
  return <div className="published-plus-pricing">
    <p className="published-pricing-label">{published.label}</p>
    <div className="published-price-grid">
      <section className="published-price">
        <h3>{published.monthly}</h3>
        <p className="price"><small>US$</small>{publishedPlus.monthlyAmount} <span>/ {copy.month}</span></p>
        <p>{copy.renew(false)}</p>
      </section>
      <section className="published-price">
        <h3>{published.yearly}</h3>
        <p className="price"><small>US$</small>{publishedPlus.yearlyAmount} <span>/ {copy.year}</span></p>
        <p>{published.annualPayment}</p>
      </section>
    </div>
  </div>;
}

export function PublishedPurchaseAvailability({locale,state}:{locale:string;state:PurchaseAvailability}) {
  const text=pricingCopy(locale),published=publishedPricingCopy(locale);
  const launchDate=new Intl.DateTimeFormat(locale,{dateStyle:'long',timeZone:'Asia/Shanghai'}).format(new Date(publishedPlus.purchaseLaunchBefore));
  return <>
    <div className="billing-availability" data-state={state}>
      <p className="billing-status" role={state==='error'?'alert':'status'}>{published[state]}</p>
      <p className="purchase-timing"><span className="purchase-launch-date">{published.launch(launchDate)}</span> {state==='unavailable'?published.timing:published.unconfirmedTiming}</p>
      <button className="button" type="button" disabled>{published[state==='unavailable'?'comingSoon':'checking']}</button>
      <noscript><p className="trial-note">{published.noScript}</p></noscript>
    </div>
    <p className="trial-note">{published.trial(publishedPlus.trialDays,publishedPlus.trialRedrawPages)} {text.cancel} {published.tax}</p>
  </>;
}
