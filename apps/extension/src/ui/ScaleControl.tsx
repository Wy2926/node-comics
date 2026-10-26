import {Icon} from '../icons';
import {msg} from '../i18n/runtime';
import './scale-control.css';

export function ScaleControl({label, value, min, max, disabled, onChange}: {
  label: string; value: number; min: number; max: number; disabled?: boolean; onChange(value: number): void;
}) {
  return <div className="nc-inline nc-scale-control" role="group" aria-label={label}>
    <button type="button" className="icon-button" aria-label={msg('缩小')} disabled={disabled || value <= min} onClick={() => onChange(Math.max(min, value - 10))}><Icon name="minus"/></button>
    <span>{value}%</span>
    <button type="button" className="icon-button" aria-label={msg('放大')} disabled={disabled || value >= max} onClick={() => onChange(Math.min(max, value + 10))}><Icon name="plus"/></button>
  </div>;
}
