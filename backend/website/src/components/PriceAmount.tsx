// Keep the localized currency order and spacing while giving the number visual priority.
export default function PriceAmount({parts}:{parts:Intl.NumberFormatPart[]}){
  return <span className="price-value">{parts.map((part,index)=>part.type==='currency'?<span key={index} className="price-currency">{part.value}</span>:part.value)}</span>;
}
