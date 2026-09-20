import {useId} from 'react';
import {billingCopy,type BillingOffer} from '../lib/billing';

export type BillingInterval='month'|'year';
const labels:Record<string,[string,string,string,string]>={
  'zh-CN':['月付','年付','每月续费','每年续费 · 额度按月生效'],
  'zh-TW':['月付','年付','每月續訂','每年續訂 · 額度按月生效'],
  en:['Monthly','Yearly','Billed every month','Billed yearly · monthly quotas'],
  ja:['月払い','年払い','毎月更新','毎年更新・利用枠は毎月'],
  ko:['월간 결제','연간 결제','매월 갱신','매년 갱신 · 한도는 매월'],
};
export function selectedInterval(offers:BillingOffer[],preferred:BillingInterval):BillingInterval{
  return offers.some(p=>p.interval===preferred)?preferred:offers[0]?.interval??preferred;
}
export default function BillingCycle({offers,value,onChange,locale,disabled=false}:{offers:BillingOffer[];value:BillingInterval;onChange:(value:BillingInterval)=>void;locale:string;disabled?:boolean}){
  const id=useId(),copy=billingCopy(locale),text=labels[locale]??labels.en;
  return <fieldset className="billing-cycle" disabled={disabled}><legend>{copy.plan}</legend>{(['month','year'] as const).map((cycle,index)=>{
    const available=offers.some(p=>p.interval===cycle);
    return <label className="billing-cycle-card" key={cycle} data-selected={value===cycle} data-disabled={!available}>
      <input type="radio" name={id} value={cycle} checked={value===cycle} disabled={!available} onChange={()=>onChange(cycle)}/>
      <strong>{text[index]}</strong><small>{available?text[index+2]:copy.unavailable}</small>
    </label>;
  })}</fieldset>;
}
