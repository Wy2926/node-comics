import {createRoot} from 'react-dom/client';
import {App} from './App';
import './styles.css';
import './redesign.css';
import './library.css';
import {connectReaderSettings} from './inline/settings';
import {settings,session} from './library/store';
void connectReaderSettings(settings(),session()).catch(()=>{}).then(()=>createRoot(document.getElementById('root')!).render(<App/>));
