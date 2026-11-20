import type {WorkProvider} from '../../discovery/types';
import {msg} from '../../i18n/runtime';
import {Select} from '../Select';

export function WorkProviderSelect({providers, value, onChange}: {
  providers: readonly WorkProvider[]; value: string; onChange: (id: string) => void;
}) {
  if (providers.length < 2) return null;
  return <label className="nc-discovery-filter">{msg('作品资料来源')}
    <Select value={value} onChange={event => onChange(event.target.value)}>
      {providers.map(provider => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
    </Select>
  </label>;
}
