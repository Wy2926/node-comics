import {FlagIcon} from './FlagIcon';
import {languageRegion} from './language-region';

export function LanguageFlag({language}: {language: string}) {
  return <FlagIcon region={languageRegion(language)}/>;
}
