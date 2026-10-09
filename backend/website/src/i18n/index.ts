import zhCN from './zh-CN';
import zhTW from './zh-TW';
import en from './en';
import ja from './ja';
import ko from './ko';
import fr from './fr';
import es from './es';
import ptBR from './pt-BR';
import de from './de';
import it from './it';
import ru from './ru';
import pl from './pl';
import uk from './uk';
import tr from './tr';
import vi from './vi';
import id from './id';
import ar from './ar';
import type { Locale, Dictionary } from './types';
import { mobileCopy, mobileGuides } from './mobile';
import {quotaPurchase,quotaPurchasePolicy} from './quota-purchase';
export { locales, prefixes, languageNames, localeFromPath, basePath, localPath } from './locales';
export type { Locale } from './types';
const baseDictionaries: Record<Locale,Dictionary> = {'zh-CN':zhCN, 'zh-TW':zhTW, 'en':en, 'ja':ja, 'ko':ko, 'fr':fr, 'es':es, 'pt-BR':ptBR, 'de':de, 'it':it, 'ru':ru, 'pl':pl, 'uk':uk, 'tr':tr, 'vi':vi, 'id':id, 'ar':ar};
export const dictionaries = Object.fromEntries(Object.entries(baseDictionaries).map(([language, dictionary]) => {
  const locale = language as Locale;
  const localized:Dictionary={
    ...dictionary,
    ui: { ...dictionary.ui, downloadDescription: mobileCopy[locale].availability },
    documents: {
      ...dictionary.documents,
      policies:{...dictionary.documents.policies,refund:{...dictionary.documents.policies.refund,sections:[...dictionary.documents.policies.refund.sections,{title:quotaPurchase[locale].title,paragraphs:[quotaPurchasePolicy[locale],quotaPurchase[locale].once,quotaPurchase[locale].subscription]}]}},
      guides: [...dictionary.documents.guides, ...mobileGuides(locale, dictionary.ui)],
      faqs: dictionary.documents.faqs.map(faq => faq.id === 'browsers'
        ? { ...faq, answer: `${mobileCopy[locale].availability} ${mobileCopy[locale].notices[1]}` } : faq),
    },
  };
  return [locale,localized];
})) as Record<Locale, Dictionary>;
export const publicPaths=['/','/features/','/pricing/','/download/','/guides/','/faq/','/help/','/about/','/changelog/','/privacy/','/terms/','/refund/',...dictionaries['zh-CN'].documents.guides.map(guide=>`/guides/${guide.slug}/`)];
