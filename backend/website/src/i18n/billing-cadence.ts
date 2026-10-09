import type {Locale} from './types';

const labels:Record<Locale,[string,string,string]>={
  'zh-CN':['季付','季度','每三个月自动续费。'],
  'zh-TW':['季付','季度','每三個月自動續訂。'],
  en:['Quarterly','quarter','Renews every three months.'],
  ja:['3か月払い','3か月','3か月ごとに自動更新。'],
  ko:['분기 결제','분기','3개월마다 자동 갱신됩니다.'],
  de:['Vierteljährlich','Quartal','Automatische Verlängerung alle drei Monate.'],
  fr:['Trimestriel','trimestre','Renouvellement automatique tous les trois mois.'],
  es:['Trimestral','trimestre','Se renueva automáticamente cada tres meses.'],
  'pt-BR':['Trimestral','trimestre','Renovação automática a cada três meses.'],
  it:['Trimestrale','trimestre','Rinnovo automatico ogni tre mesi.'],
  ru:['Ежеквартально','квартал','Автоматическое продление каждые три месяца.'],
  pl:['Kwartalnie','kwartał','Automatyczne odnowienie co trzy miesiące.'],
  uk:['Щоквартально','квартал','Автоматичне поновлення кожні три місяці.'],
  tr:['Üç aylık','üç ay','Her üç ayda bir otomatik yenilenir.'],
  vi:['Hàng quý','quý','Tự động gia hạn ba tháng một lần.'],
  id:['Triwulanan','triwulan','Diperpanjang otomatis setiap tiga bulan.'],
  ar:['ربع سنوي','ربع سنة','يتجدد تلقائيًا كل ثلاثة أشهر.'],
};
export function quarterlyCopy(locale:string){
  const [label,unit,renewal]=labels[locale as Locale]??labels.en;
  return {label,unit,renewal};
}
