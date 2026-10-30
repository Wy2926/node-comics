import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dictionaries, locales} from '../src/i18n';
import {publishedModels, publishedOffers} from '../src/data/published-plans';
import {prepaidMembershipCopy} from '../src/i18n/prepaid-membership';

test('prepaid terms and refund pages disclose no renewal, queued purchases and monthly allowance in every locale',()=>{
  for(const locale of locales){
    const copy=prepaidMembershipCopy(locale);
    for(const key of ['terms','refund']){
      const section=dictionaries[locale].documents.policies[key].sections.find(section=>section.title===copy.status);
      assert.deepEqual(section?.paragraphs,[copy.notice,copy.quotaRule],`${locale}: ${key}`);
    }
    assert.ok(dictionaries[locale].documents.faqs.find(faq=>faq.id==='cancel-subscription')?.answer.startsWith(copy.notice),locale);
  }
});

test('all policies have an explicit revision and preserve separate data-processing disclosures', () => {
  for (const locale of locales) {
    const {policies} = dictionaries[locale].documents;
    for (const [key, policy] of Object.entries(policies))
      assert.equal(policy.updated, key === 'privacy' ? '2026-10-30' : '2026-10-17', locale);
    const privacy = policies.privacy.sections.flatMap(section => section.paragraphs).join('\n');
    for (const required of ['localStorage', 'sessionStorage', 'IndexedDB', 'Cloudflare R2', 'PDF', 'ZIP', 'CBZ', 'Google Analytics 4', '14']) {
      assert.ok(privacy.includes(required), `${locale}: missing privacy disclosure ${required}`);
    }
    const document = policies.privacy.sections.find(section => section.title.includes('CBZ'));
    assert.ok(document, `${locale}: independent document retention`);
    for (const duration of ['1', '24', '7']) assert.ok(document.paragraphs.join(' ').includes(duration), locale);
    assert.ok(policies.terms.sections.some(section => section.paragraphs.some(text => text.includes('GPL-3.0-only'))), locale);
  }
});

test('reading-position sync is scoped to OPDS libraries, not NodeLane cloud sync, in every language', () => {
  const notCloudSync: Record<(typeof locales)[number], string> = {
    'zh-CN': '不是 NodeLane 云同步',
    'zh-TW': '不是 NodeLane 雲端同步',
    en: 'not NodeLane cloud synchronization',
    ja: 'NodeLane のクラウド同期ではありません',
    ko: 'NodeLane 클라우드 동기화가 아닙니다',
    fr: 'non d’une synchronisation cloud NodeLane',
    es: 'no de una sincronización en la nube de NodeLane',
    'pt-BR': 'não uma sincronização na nuvem da NodeLane',
    de: 'keine NodeLane-Cloud-Synchronisierung',
    it: 'non di una sincronizzazione cloud di NodeLane',
    ru: 'не облачная синхронизация NodeLane',
    pl: 'nie synchronizacja w chmurze NodeLane',
    uk: 'не хмарна синхронізація NodeLane',
    tr: 'NodeLane bulut eşitlemesi değildir',
    vi: 'không phải đồng bộ đám mây NodeLane',
    id: 'bukan sinkronisasi cloud NodeLane',
    ar: 'وليست مزامنة سحابية عبر NodeLane',
  };
  for (const locale of locales) {
    const paragraph = dictionaries[locale].documents.policies.privacy.sections
      .flatMap(section => section.paragraphs).find(text => text.includes('localStorage'));
    assert.ok(paragraph, `${locale}: missing local-storage disclosure`);
    assert.ok(paragraph.includes('OPDS'), `${locale}: progress sync must identify the source library`);
    assert.ok(paragraph.includes(notCloudSync[locale]), `${locale}: progress sync is not NodeLane cloud sync`);
  }
});

test('terms and refund share the catalog summary with FAQ, including every price and allowance', () => {
  for (const locale of locales) {
    const {policies, faqs} = dictionaries[locale].documents;
    const summary = faqs.find(faq => faq.answer.includes(publishedModels.free[0]))!.answer;
    for (const key of ['terms', 'refund']) {
      assert.ok(policies[key].sections.some(section => section.paragraphs.includes(summary)), `${locale}: ${key}`);
    }
    // Localized separators vary, but each catalog amount and page count must appear.
    const numbers = summary.replace(/(?<=\d)[.,\s\u00a0](?=\d{3}(?!\d))/g, '').replace(/(?<=\d),(?=\d{2}(?!\d))/g, '.');
    for (const offer of publishedOffers) {
      assert.ok(numbers.includes((offer.unit_amount / 100).toFixed(2)), `${locale}: price ${offer.id}`);
      const pages = offer.interval === 'once' ? offer.quota_pages : offer.monthly_classic_pages;
      assert.ok(pages && numbers.includes(String(pages)), `${locale}: pages ${offer.id}`);
      assert.equal(offer.currency, 'usd');
      assert.ok(['quarter', 'year', 'once'].includes(offer.interval));
      assert.equal(offer.trial_days, 0);
    }
  }
});

test('pack admission benefits require actual purchased-page use in every language', () => {
  const consumptionScope: Record<(typeof locales)[number], string> = {
    'zh-CN': '实际扣除购买额度的任务',
    'zh-TW': '實際扣除購買額度的任務',
    en: 'Tasks that actually consume purchased pages',
    ja: '購入枠を実際に消費するタスク',
    ko: '구매 페이지를 실제로 차감하는 작업',
    fr: 'Les tâches qui consomment réellement des pages achetées',
    es: 'Las tareas que consumen realmente páginas compradas',
    'pt-BR': 'Tarefas que realmente consomem páginas compradas',
    de: 'Aufgaben, die tatsächlich gekaufte Seiten verbrauchen',
    it: 'Le attività che consumano effettivamente pagine acquistate',
    ru: 'Задания, фактически расходующие купленные страницы',
    pl: 'Zadania faktycznie zużywające zakupione strony',
    uk: 'Завдання, які фактично витрачають придбані сторінки',
    tr: 'Satın alınan sayfaları gerçekten tüketen görevler',
    vi: 'Tác vụ thực sự trừ trang đã mua',
    id: 'Tugas yang benar-benar memakai halaman yang dibeli',
    ar: 'المهام التي تستهلك فعلياً صفحات مشتراة',
  };
  for (const locale of locales) {
    const terms = dictionaries[locale].documents.policies.terms;
    assert.ok(terms.sections.some(section => section.paragraphs.some(text =>
      text.includes(consumptionScope[locale]) && text.includes('PLUS'))), `${locale}: pack admission scope`);
  }
});

test('rate FAQ agrees with terms and does not advertise the retired universal hourly cap', () => {
  for (const locale of locales) {
    const {policies, faqs} = dictionaries[locale].documents;
    const rate = faqs.find(faq => faq.id === 'plus-limits')!.answer;
    assert.ok(policies.terms.sections.some(section => section.paragraphs.includes(rate)), locale);
    for (const required of ['10', '100', '60']) assert.ok(rate.includes(required), locale);
    assert.doesNotMatch(JSON.stringify({policies, rate}), /1[, .]?200/);
    assert.ok(policies.refund.sections.some(section => section.paragraphs.some(text => text.includes('UTC'))), `${locale}: monthly windows are not monthly billing`);
  }
});
