import {publishedModels} from '../data/published-plans';
import {pricingHighlightsCopy} from '../i18n/pricing-highlights';

export default function PlanModels({locale,paid}:{locale:string;paid:boolean}){
  const copy=pricingHighlightsCopy(locale);
  return <div className="plan-models">
    <h3>{copy.freeModels}</h3>
    <ul>{publishedModels.free.map(model=><li key={model}><span className="ui-icon icon-check" aria-hidden="true"/><bdi>{model}</bdi></li>)}</ul>
    <h3>{paid?copy.paidModels:copy.paidOnly}</h3>
    <ul data-included={paid}>{publishedModels.paid_extra.map(model=><li key={model}>
      {paid?<span className="ui-icon icon-check" aria-hidden="true"/>:<span className="model-unavailable" aria-hidden="true">−</span>}<bdi>{model}</bdi>
    </li>)}</ul>
  </div>;
}
