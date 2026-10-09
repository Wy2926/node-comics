import type {Locale} from './types';
import {commerce as fr} from './extra/fr';
import {commerce as es} from './extra/es';
import {commerce as ptBR} from './extra/pt-BR';
import {commerce as de} from './extra/de';
import {commerce as it} from './extra/it';
import {commerce as ru} from './extra/ru';
import {commerce as pl} from './extra/pl';
import {commerce as uk} from './extra/uk';
import {commerce as tr} from './extra/tr';
import {commerce as vi} from './extra/vi';
import {commerce as id} from './extra/id';
import {commerce as ar} from './extra/ar';
const copies = {'fr':fr,'es':es,'pt-BR':ptBR,'de':de,'it':it,'ru':ru,'pl':pl,'uk':uk,'tr':tr,'vi':vi,'id':id,'ar':ar};
export const commerceCopy = (locale:string) => copies[locale as keyof typeof copies];
export function formatCopy(template:string,values:Record<string,string|number>) {
  return template.replace(/\{(\w+)\}/g,(token,key)=>String(values[key]??token));
}

interface CheckoutStatusCopy {uncertain:string;conflict:string}
const copy:Record<Locale,CheckoutStatusCopy>={
  'zh-CN':{uncertain:'本次结账结果仍待核实。重试会继续同一请求；请勿重复支付同一订单。若仍无法继续，请联系 comics@nodelane.net 核实。',conflict:'本次请求的报价或支付渠道与原请求不一致。如有待处理订阅，请刷新本页后继续原结账；若仍有问题，请联系 comics@nodelane.net。'},
  'zh-TW':{uncertain:'本次結帳結果仍待確認。重試會繼續同一請求；請勿重複支付同一訂單。若仍無法繼續，請聯絡 comics@nodelane.net 確認。',conflict:'本次請求的報價或付款管道與原請求不一致。如有待處理訂閱，請重新整理本頁後繼續原結帳；若仍有問題，請聯絡 comics@nodelane.net。'},
  en:{uncertain:'This checkout is still unverified. Retrying continues the same request; do not pay the same order twice. If you still cannot continue, contact comics@nodelane.net.',conflict:'The offer or payment provider differs from the original request. For a pending subscription, refresh this page to resume its checkout. If the issue persists, contact comics@nodelane.net.'},
  ja:{uncertain:'今回の決済結果はまだ確認できていません。再試行では同じリクエストを続行します。同じ注文を二重に支払わないでください。続行できない場合は comics@nodelane.net にご連絡ください。',conflict:'料金または決済サービスが元のリクエストと一致しません。処理中の購読がある場合は、このページを更新して元の決済を続行してください。解決しない場合は comics@nodelane.net にご連絡ください。'},
  ko:{uncertain:'이 결제 결과는 아직 확인되지 않았습니다. 다시 시도하면 같은 요청을 이어갑니다. 같은 주문을 두 번 결제하지 마세요. 계속할 수 없다면 comics@nodelane.net으로 문의하세요.',conflict:'가격 또는 결제 서비스가 원래 요청과 다릅니다. 대기 중인 구독이 있다면 이 페이지를 새로고침해 기존 결제를 이어가세요. 문제가 계속되면 comics@nodelane.net으로 문의하세요.'},
  fr:{uncertain:'Ce paiement reste à vérifier. Réessayer reprend la même demande ; ne payez pas deux fois la même commande. Si vous ne pouvez toujours pas continuer, contactez comics@nodelane.net.',conflict:'L’offre ou le prestataire de paiement diffère de la demande initiale. Pour un abonnement en attente, actualisez cette page afin de reprendre son paiement. Si le problème persiste, contactez comics@nodelane.net.'},
  es:{uncertain:'Este pago sigue sin verificarse. Al reintentar se continúa la misma solicitud; no pague dos veces el mismo pedido. Si aún no puede continuar, contacte con comics@nodelane.net.',conflict:'La oferta o el proveedor de pago no coincide con la solicitud original. Si hay una suscripción pendiente, actualice esta página para continuar su pago. Si el problema persiste, contacte con comics@nodelane.net.'},
  'pt-BR':{uncertain:'Este pagamento ainda não foi verificado. Tentar novamente continua a mesma solicitação; não pague o mesmo pedido duas vezes. Se ainda não conseguir continuar, contate comics@nodelane.net.',conflict:'A oferta ou o provedor de pagamento difere da solicitação original. Para uma assinatura pendente, atualize esta página para retomar o pagamento. Se o problema persistir, contate comics@nodelane.net.'},
  de:{uncertain:'Dieser Bezahlvorgang ist noch ungeklärt. Ein erneuter Versuch setzt dieselbe Anfrage fort; bezahlen Sie dieselbe Bestellung nicht zweimal. Falls Sie weiterhin nicht fortfahren können, wenden Sie sich an comics@nodelane.net.',conflict:'Das Angebot oder der Zahlungsanbieter weicht von der ursprünglichen Anfrage ab. Aktualisieren Sie bei einem ausstehenden Abonnement diese Seite, um dessen Bezahlvorgang fortzusetzen. Bei weiteren Problemen wenden Sie sich an comics@nodelane.net.'},
  it:{uncertain:'Questo pagamento è ancora da verificare. Un nuovo tentativo continua la stessa richiesta; non pagare due volte lo stesso ordine. Se non riesci ancora a proseguire, contatta comics@nodelane.net.',conflict:'L’offerta o il fornitore di pagamento non corrisponde alla richiesta originale. Per un abbonamento in sospeso, aggiorna questa pagina per riprendere il pagamento. Se il problema persiste, contatta comics@nodelane.net.'},
  ru:{uncertain:'Результат этой оплаты ещё не подтверждён. Повторная попытка продолжит тот же запрос; не оплачивайте один заказ дважды. Если продолжить не удаётся, напишите на comics@nodelane.net.',conflict:'Предложение или платёжный сервис не соответствует исходному запросу. Если есть незавершённая подписка, обновите эту страницу, чтобы продолжить её оплату. Если проблема остаётся, напишите на comics@nodelane.net.'},
  pl:{uncertain:'Ta płatność nie została jeszcze zweryfikowana. Ponowna próba kontynuuje to samo żądanie; nie płać dwa razy za to samo zamówienie. Jeśli nadal nie możesz kontynuować, napisz na comics@nodelane.net.',conflict:'Oferta lub dostawca płatności różni się od pierwotnego żądania. Jeśli subskrypcja oczekuje na płatność, odśwież tę stronę, aby ją wznowić. Jeśli problem nie ustępuje, napisz na comics@nodelane.net.'},
  uk:{uncertain:'Результат цієї оплати ще не підтверджено. Повторна спроба продовжить той самий запит; не оплачуйте одне замовлення двічі. Якщо продовжити не вдається, напишіть на comics@nodelane.net.',conflict:'Пропозиція або платіжний сервіс не відповідає початковому запиту. Якщо є незавершена підписка, оновіть цю сторінку, щоб продовжити її оплату. Якщо проблема залишається, напишіть на comics@nodelane.net.'},
  tr:{uncertain:'Bu ödemenin sonucu henüz doğrulanmadı. Yeniden denemek aynı isteği sürdürür; aynı sipariş için iki kez ödeme yapmayın. Hâlâ devam edemiyorsanız comics@nodelane.net ile iletişime geçin.',conflict:'Teklif veya ödeme sağlayıcısı ilk istekle eşleşmiyor. Bekleyen bir abonelik varsa ödemesini sürdürmek için bu sayfayı yenileyin. Sorun devam ederse comics@nodelane.net ile iletişime geçin.'},
  vi:{uncertain:'Kết quả thanh toán này chưa được xác minh. Thử lại sẽ tiếp tục cùng yêu cầu; đừng thanh toán hai lần cho cùng đơn hàng. Nếu vẫn không thể tiếp tục, hãy liên hệ comics@nodelane.net.',conflict:'Báo giá hoặc nhà cung cấp thanh toán không khớp với yêu cầu ban đầu. Nếu có gói đăng ký đang chờ, hãy làm mới trang này để tiếp tục thanh toán. Nếu sự cố vẫn còn, hãy liên hệ comics@nodelane.net.'},
  id:{uncertain:'Hasil pembayaran ini belum terverifikasi. Mencoba lagi akan melanjutkan permintaan yang sama; jangan membayar pesanan yang sama dua kali. Jika tetap tidak dapat melanjutkan, hubungi comics@nodelane.net.',conflict:'Penawaran atau penyedia pembayaran berbeda dari permintaan awal. Jika ada langganan tertunda, muat ulang halaman ini untuk melanjutkan pembayarannya. Jika masalah berlanjut, hubungi comics@nodelane.net.'},
  ar:{uncertain:'لم تُؤكَّد نتيجة عملية الدفع هذه بعد. تعيد المحاولة متابعة الطلب نفسه؛ لا تدفع ثمن الطلب نفسه مرتين. إذا تعذّرت المتابعة، تواصل مع comics@nodelane.net.',conflict:'العرض أو مزوّد الدفع لا يطابق الطلب الأصلي. إذا كان لديك اشتراك معلّق، فحدّث هذه الصفحة لمتابعة دفعه. إذا استمرت المشكلة، تواصل مع comics@nodelane.net.'},
};
export const checkoutStatusCopy=(locale:string):CheckoutStatusCopy=>copy[locale as Locale]??copy.en;
