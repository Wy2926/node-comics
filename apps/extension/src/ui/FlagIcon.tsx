import {Icon} from '../icons';
import regions from '../../public/flags/regions.json';
import './flag-icon.css';

// Complete local country/territory collection. No network lookup or source-site dependency.
const flags = new Set(regions);

/** Decorative country/region cue. The adjacent label provides the accessible name. */
export function FlagIcon({region}: {region?: string}) {
  const code = region?.toLowerCase(), url = code && flags.has(code) ? `${import.meta.env.BASE_URL}flags/${code}.svg` : undefined;
  return url ? <img className="nc-flag-icon" src={url} width={20} height={15} alt="" aria-hidden="true" draggable={false}/>
    : <Icon name="globe" size={20} className="nc-language-globe"/>;
}
