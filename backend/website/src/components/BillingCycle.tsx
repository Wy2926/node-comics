import {quarterlyCopy} from '../i18n/billing-cadence';
import {commerceCopy} from '../i18n/commerce';
import {useId} from 'react';
import {billingCopy,annualSavings,type BillingOffer} from '../lib/billing';
import {pricingCopy} from '../lib/pricing';
import type {BillingInterval} from '../lib/billing-cycle';

export {selectedInterval,type BillingInterval} from '../lib/billing-cycle';
const labels:Record<string,[string,string,string,string]>={
  'zh-CN':['月付','年付','每月续费','每年续费'],
  'zh-TW':['月付','年付','每月續訂','每年續訂'],
  en:['Monthly','Yearly','Billed every month','Billed yearly'],
  ja:['月払い','年払い','毎月更新','毎年更新'],
  ko:['월간 결제','연간 결제','매월 갱신','매년 갱신'],
};
export default function BillingCycle({offers,value,onChange,locale,disabled=false,preview=false,annualDiscount}:{offers:BillingOffer[];value:BillingInterval;onChange:(value:BillingInterval)=>void;locale:string;disabled?:boolean;preview?:boolean;annualDiscount?:number}){
  const id=useId(),copy=billingCopy(locale),text=commerceCopy(locale)?.billingCycle??labels[locale]??labels.en;
  const annualOffers=offers.filter(p=>p.interval==='year');
  const discount=annualDiscount??(annualOffers.length?Math.min(...annualOffers.map(p=>annualSavings(p,offers)?.percent??0)):0);
  const cycles:BillingInterval[]=offers.some(p=>p.interval==='month')?['month',...(offers.some(p=>p.interval==='quarter')?['quarter' as const]:[]),'year']:['quarter','year'];
  const control=<fieldset className={`billing-cycle${preview?' billing-cycle-segmented':''}`} disabled={disabled}><legend>{copy.plan}</legend>{cycles.map(cycle=>{
    const available=preview||offers.some(p=>p.interval===cycle);
    return <label className="billing-cycle-card" key={cycle} data-selected={value===cycle} data-disabled={!available}>
      <input type="radio" name={id} value={cycle} checked={value===cycle} disabled={!available} onChange={()=>onChange(cycle)}/>
      <strong>{cycle==='quarter'?quarterlyCopy(locale).label:text[cycle==='year'?1:0]}</strong>{!preview&&cycle==='year'&&discount>0&&<span className="annual-badge">{pricingCopy(locale).save(discount)}</span>}{!preview&&<small>{available?(cycle==='quarter'?quarterlyCopy(locale).renewal:text[cycle==='year'?3:2]):copy.unavailable}</small>}
    </label>;
  })}</fieldset>;
  return preview?<div className="billing-cycle-picker">{control}<p className="billing-cycle-saving">{discount>0&&<span className="annual-badge">{pricingCopy(locale).save(discount)}</span>}</p></div>:control;
}
