import {createRoot} from 'react-dom/client';
import {App} from './App';
import {AdminTheme} from './theme';
import './admin.css';

createRoot(document.getElementById('root')!).render(<AdminTheme><App/></AdminTheme>);
