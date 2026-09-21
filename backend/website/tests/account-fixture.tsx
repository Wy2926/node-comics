import {createRoot} from 'react-dom/client';
import Account from '../src/components/Account';
import '../src/styles/global.css';
import {dictionaries} from '../src/i18n';
import type {Locale} from '../src/i18n/types';
if(location.port!=='5193')throw Error('Use isolated port 5193.');
const locale=(new URLSearchParams(location.search).get('locale')||'zh-CN') as Locale;
const d=dictionaries[locale];
createRoot(document.getElementById('root')!).render(<main style={{maxWidth:1000,margin:'32px auto',padding:24}}><header style={{maxWidth:760,margin:'0 auto 28px'}}><h1>{d.ui.accountTitle}</h1><p>{d.ui.accountDescription}</p></header><Account locale={locale} copy={d.account}/></main>);
