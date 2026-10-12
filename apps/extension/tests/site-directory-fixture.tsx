/** Isolated directory UI: no account, import, feedback or translation requests. */
import {useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {ComicSites} from '../src/ui/ComicSites';
import {installDictionary} from '../src/i18n/runtime';
import english from '../src/i18n/dictionaries/en.json';
import german from '../src/i18n/dictionaries/de.json';
import '../src/styles.css';
import '../src/redesign.css';
import '../src/library.css';
import '../src/ui/theme/surfaces.css';
import '../src/ui/phone.css';

if (location.hostname !== '127.0.0.1' || location.port !== '5205') throw Error('Use the isolated 127.0.0.1:5205 fixture.');
window.fetch = async () => {throw Error('Fixture: network requests disabled');};
const options = new URLSearchParams(location.search);
const locale = options.get('locale');
installDictionary(locale === 'de' ? 'de' : locale === 'en' ? 'en' : 'zh-CN', locale === 'de' ? german : locale === 'en' ? english : {});
document.documentElement.dataset.appearance = options.get('appearance') === 'dark' ? 'dark' : 'light';
function Fixture() {
  useEffect(() => {
    if (options.has('brokenIcon')) document.querySelector('.nc-site-monogram img')?.setAttribute('src', '/fixture-missing-icon.svg');
  }, []);
  return <main className="nc-app" style={{maxWidth: 'var(--page-max-width)', padding: 24, margin: '0 auto'}}>
    <ComicSites onImport={async () => {throw Error('Fixture: import unavailable');}}/>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
