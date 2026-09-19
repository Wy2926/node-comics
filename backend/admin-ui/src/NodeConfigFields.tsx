type Property = {type?: string; minimum?: number; maximum?: number; const?: number; anyOf?: Property[]};
export type ConfigSchema = {
  defaults: Record<string, unknown>; node: {properties: Record<string, Property>};
  pool_limits: Record<string, number>;
  languages: {id: string; label: string}[];
};
const labels: Record<string, string> = {
  execution_slots: '同时执行位', poll_seconds: '领取兜底检查间隔（秒）', heartbeat_seconds: '心跳间隔（秒）',
  request_seconds: '控制请求超时（秒）',
  page_seconds: '整页处理时限（秒）', text_wait_seconds: '等待译文时限（秒）',
  delivery_seconds: '结果交付时限（秒）',
};
const numeric = (property: Property) => property.anyOf?.find(p => p.type !== 'null') || property;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function parseConfig(text: string, schema: ConfigSchema, pool?: string): Record<string, unknown> {
  let value: unknown;
  try {value = JSON.parse(text);} catch {throw Error('配置 JSON 格式不正确，请检查后重试。');}
  if (!object(value)) throw Error('配置必须是 JSON 对象。');
  function check(values: Record<string, unknown>, properties: Record<string, Property>) {
    for (const [key, current] of Object.entries(values)) {
      if (!(key in properties)) throw Error(`不支持的配置字段：${key}`);
      if (key === 'allowed_languages') {
        if (!Array.isArray(current) || !current.length || current.length > schema.languages.length ||
            current.some(code => !schema.languages.some(language => language.id === code))) throw Error('请至少选择一种支持的语言。');
      } else {
        const rule = numeric(properties[key]);
        if (typeof current !== 'number' || !Number.isFinite(current) ||
            (rule.type === 'integer' && !Number.isInteger(current)) ||
            (rule.minimum != null && current < rule.minimum) || (rule.maximum != null && current > rule.maximum) ||
            (rule.const != null && current !== rule.const)) throw Error(`${labels[key] || key} 的数值或范围无效。`);
      }
    }
  }
  const properties = pool ? {execution_slots: {type: 'integer', minimum: 1, maximum: schema.pool_limits[pool]}} : schema.node.properties;
  check(value, properties);
  if (pool && value.execution_slots == null) throw Error('请填写同时执行位。');
  return pool ? value : {...schema.defaults, ...value};
}

export function NodeConfigFields({value, onChange, schema, pool, languages}: {
  value: Record<string, unknown>; onChange: (value: Record<string, unknown>) => void;
  schema: ConfigSchema; pool?: string; languages: string[];
}) {
  const selected = (value.allowed_languages ?? languages) as string[];
  function updateLanguages(current: string[]) { onChange({...value, allowed_languages: current}); }
  function fields(properties: Record<string, Property>, values: Record<string, unknown>) {
    return Object.entries(properties).filter(([key]) => key in labels).map(([key, property]) => {
      const rule = numeric(property);
      return <label key={key}>{labels[key]}<input type="number" required
        min={rule.minimum} max={rule.maximum} step={rule.type === 'integer' ? 1 : 'any'}
        value={values[key] == null ? '' : String(values[key])}
        onChange={e => {
          const current = e.target.value === '' ? '' : Number(e.target.value);
          onChange({...value, [key]: current});
        }}/><small className="muted">{rule.minimum}–{rule.maximum}</small></label>;
    });
  }
  return <>
    <div className="config-grid">{fields(pool ? {execution_slots: {type: 'integer', minimum: 1, maximum: schema.pool_limits[pool]}} : schema.node.properties, value)}</div>
    {!pool && <>
      <section className="config-section"><h3>目标语言</h3>
        <p className="muted">中心只派发所选语言与节点实际支持语言的交集。当前选中 {selected.length} / {schema.languages.length}。</p>
        <fieldset className="language-options">
          <legend className="sr-only">支持的目标语言</legend>
          <div className="language-actions"><button type="button" className="text-link" onClick={() => updateLanguages(schema.languages.map(l => l.id))}>全选语言</button>
            <button type="button" className="text-link" onClick={() => updateLanguages([])}>清空选择</button></div>
          <div className="language-grid">{schema.languages.map(language => <label className="language-option" key={language.id}>
            <input type="checkbox" checked={selected.includes(language.id)} onChange={e => updateLanguages(e.target.checked ? [...selected, language.id] : selected.filter(code => code !== language.id))}/>
            <span>{language.label}<small>{language.id}</small></span></label>)}</div>
        </fieldset>
      </section>
    </>}
  </>;
}
