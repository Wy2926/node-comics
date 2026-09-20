import {useEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Select, type SelectChangeEvent} from '../src/ui/Select';
import {TargetLanguage} from '../src/ui/TargetLanguage';
import {InterfaceLanguage} from '../src/ui/InterfaceLanguage';
import type {UiLanguage} from '../src/i18n/locales';
import '../src/styles.css';
import '../src/redesign.css';
import '../src/library.css';
import '../src/ui/theme/surfaces.css';

function Fixture() {
  const [value, setValue] = useState('apple'), [label, setLabel] = useState('作品');
  const [disabled, setDisabled] = useState(false), [empty, setEmpty] = useState(false);
  const [changes, setChanges] = useState<SelectChangeEvent[]>([]);
  const [language, setLanguage] = useState('zh-Hans'), [uiLanguage, setUiLanguage] = useState<UiLanguage>('auto');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const recordKey = () => { document.body.dataset.unhandledKeys = String(Number(document.body.dataset.unhandledKeys ?? 0) + 1); };
    window.addEventListener('keydown', recordKey);
    return () => window.removeEventListener('keydown', recordKey);
  }, []);
  const options = <><option value="apple">Apple</option><option value="apricot" disabled>Apricot</option>
    <option value="banana">Banana</option><option value="blueberry">Blueberry</option><option value="cherry">Cherry</option>
    <optgroup label="Unavailable" disabled><option value="date">Date</option></optgroup>
    <option value="hidden" hidden>Hidden</option></>;
  function change(event: SelectChangeEvent) { setChanges(previous => [...previous, event]); setValue(event.currentTarget.value); }
  return <main className="nc-app" style={{display: 'block', padding: 48}}>
    <h1>Select 键盘与弹层测试</h1>
    <form id="select-form" style={{maxWidth: 380, marginTop: 24}}>
      <button type="button" id="before">Before</button>
      <label className="field">{label}<Select id="work" name="work" title="Choose a work" value={value} onChange={change} disabled={disabled} aria-describedby="work-help">{empty ? null : options}</Select></label>
      <button type="button" id="after">After</button>
      <p id="work-help">Only the chosen work is saved.</p>
      <label htmlFor="external">外部标签</label><Select id="external" value={value} onChange={change}>{options}</Select>
      <Select aria-label="显式标签" value={1} onChange={event => setValue(event.target.value)}><option value={1}>One</option><option>Two</option></Select>
      <Select aria-label="禁用选择" value="apple" disabled onChange={change}>{options}</Select>
      <Select aria-label="空选项" value="" onChange={change}/>
    </form>
    <output id="changes">{JSON.stringify(changes)}</output>
    <div style={{display: 'flex', gap: 16, margin: '24px 0'}}>
      <button onClick={() => setValue('cherry')}>External value</button>
      <button onClick={() => setLabel('Work')}>Translate label</button>
      <button onClick={() => setDisabled(!disabled)}>Toggle disabled</button>
      <button onClick={() => setEmpty(!empty)}>Toggle options</button>
      <button onClick={() => dialog.current?.showModal()}>Open dialog</button>
    </div>
    <section className="nc-popup-language" style={{width: 380}}>
      <TargetLanguage value={language} onChange={setLanguage} describedBy="work-help"/>
    </section>
    <InterfaceLanguage value={uiLanguage} onChange={setUiLanguage}/>
    <dialog ref={dialog} aria-label="Select dialog" style={{width: 440, height: 170, overflow: 'hidden', padding: 24}}>
      <div style={{height: 74, overflow: 'hidden'}}>
        <label className="field">弹窗作品<Select value={value} onChange={change}>{options}</Select></label>
      </div>
      <button onClick={() => dialog.current?.close()}>Close dialog</button>
    </dialog>
    <div id="edge" style={{position: 'fixed', bottom: 12, right: 12}}>
      <Select aria-label="长列表" value="0" onChange={change}>{Array.from({length: 40}, (_, index) => <option key={index} value={index}>Option {index}</option>)}</Select>
    </div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
