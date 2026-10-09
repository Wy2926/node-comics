import {publishedModels} from '../data/published-plans';
import {pricingHighlightsCopy} from '../i18n/pricing-highlights';
import type {BillingOffer} from '../lib/billing';
import {comparisonCopy,comparisonRows,extraPagesCopy,paidComparisonValue} from '../lib/pricing-comparison';
import FeatureInfo from './FeatureInfo';

export default function PlanComparison({locale,plans,freeName}:{locale:string;plans:BillingOffer[];freeName:string}){
  const copy=comparisonCopy(locale),text=pricingHighlightsCopy(locale),rows=comparisonRows(locale,0);
  const models=[...publishedModels.free,...publishedModels.paid_extra];
  const availability=(included:boolean)=><span className="model-access">
    <span className={included?'ui-icon icon-check':'model-unavailable'} aria-hidden="true">{included?'':'−'}</span>
    <span className="visually-hidden">{included?text.included:text.notIncluded}</span>
  </span>;
  const feature=(row:typeof rows[number])=><tr key={row.key} data-feature={row.key}>
    <th scope="row">{row.label}{row.detail&&<FeatureInfo label={row.label} detail={row.detail}/>}</th>
    <td><strong>{row.free}</strong></td>
    {plans.map(plan=>{const value=paidComparisonValue(row,plan,locale),extra=row.key==='classic'?extraPagesCopy(plan,plans,locale):'';return <td key={plan.id} data-advantage={value!==row.free} data-more-pages={!!extra}>
      <strong>{value}</strong>{extra&&<small className="comparison-delta">{extra}</small>}
    </td>;})}
  </tr>;
  return <div className="comparison-scroll" role="region" aria-label={copy.feature} tabIndex={0}>
    <table className="plan-comparison">
      <caption>{copy.feature}</caption>
      <colgroup><col className="feature-column"/>{[freeName,...plans.map(plan=>plan.id)].map((key,index)=><col key={`${key}-${index}`}/>)}</colgroup>
      <thead><tr><th scope="col">{copy.feature}</th><th scope="col">{freeName}</th>{plans.map(plan=><th scope="col" key={plan.id}>{plan.name}</th>)}</tr></thead>
      <tbody>
        {feature(rows[0])}
        {models.map(model=><tr key={model} data-model={model}>
          <th scope="row"><bdi>{model}</bdi>{publishedModels.paid_extra.includes(model)&&<small className="comparison-model-tier">{text.paidModels}</small>}</th><td data-unavailable={!publishedModels.free.includes(model)}>{availability(publishedModels.free.includes(model))}</td>
          {plans.map(plan=><td key={plan.id} data-advantage={publishedModels.paid_extra.includes(model)}>{availability(true)}</td>)}
        </tr>)}
        {rows.filter(row=>row.key!=='classic'&&row.key!=='model').map(feature)}
      </tbody>
    </table>
  </div>;
}
