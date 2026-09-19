type Property = {type?: string; minimum?: number; maximum?: number; const?: number; anyOf?: Property[]};
export type ConfigSchema = {
  defaults: Record<string, unknown>; node: {properties: Record<string, Property>};
  engine: {properties: Record<string, Property>}; pool_limits: Record<string, number>;
  languages: {id: string; label: string}[];
};
const labels: Record<string, string> = {
  execution_slots: '同时执行位', poll_seconds: '任务轮询间隔（秒）', heartbeat_seconds: '心跳间隔（秒）',
  config_poll_seconds: '配置同步间隔（秒）', request_seconds: '控制请求超时（秒）', stage_seconds: '阶段超时（秒）',
  input_cache_bytes: '原图缓存上限（字节）', input_cache_ttl_seconds: '原图缓存时间（秒）',
  torch_threads: 'PyTorch 线程数', opencv_threads: 'OpenCV 线程数',
  cache_bytes: '引擎缓存上限（字节）', cache_ttl_seconds: '引擎缓存时间（秒）',
  page_seconds: '整页处理时限（秒）', text_wait_seconds: '等待译文时限（秒）',
  delivery_seconds: '结果交付时限（秒）', waiting_heartbeat_seconds: '等待译文时的心跳间隔（秒）',
};
const numeric = (property: Property) => property.anyOf?.find(p => p.type !== 'null') || property;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function parseConfig(text: string, schema: ConfigSchema, pool?: string): Record<string, unknown> {
  let value: unknown;
  try {value = JSON.parse(text);} catch {throw Error('配置 JSON 格式不正确，请检查后重试。');}
  if (!object(value)) throw Error('配置必须是 JSON 对象。');
  function check(values: Record<string, unknown>, properties: Record<string, Property>, optional = false) {
    for (const [key, current] of Object.entries(values)) {
      if (!(key in properties)) throw Error(`不支持的配置字段：${key}`);
      if (optional && current == null) continue;
      if (key === 'engine') {
        if (!object(current)) throw Error('engine 必须是 JSON 对象。');
        check(current, schema.engine.properties, true);
      } else if (key === 'languages' || key === 'allowed_languages') {
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

export function NodeConfigFields({value, onChange, schema, pool, languages, wholePage = false}: {
  value: Record<string, unknown>; onChange: (value: Record<string, unknown>) => void;
  schema: ConfigSchema; pool?: string; languages: string[]; wholePage?: boolean;
}) {
  const engine = (value.engine || {}) as Record<string, unknown>;
  const selected = (wholePage ? value.allowed_languages ?? languages : engine.languages ?? languages) as string[];
  function updateLanguages(current: string[]) {
    if (wholePage) onChange({...value, allowed_languages: current}); else updateEngine('languages', current);
  }
  function updateEngine(key: string, current: unknown) {
    const next = {...engine};
    if (current === undefined) delete next[key]; else next[key] = current;
    onChange({...value, engine: next});
  }
  function fields(properties: Record<string, Property>, values: Record<string, unknown>, optional = false) {
    const legacy = ['config_poll_seconds', 'stage_seconds', 'input_cache_bytes', 'input_cache_ttl_seconds'];
    const pageOnly = ['page_seconds', 'text_wait_seconds', 'delivery_seconds', 'waiting_heartbeat_seconds'];
    return Object.entries(properties).filter(([key]) => key in labels && !(wholePage ? legacy : pageOnly).includes(key)).map(([key, property]) => {
      const rule = numeric(property);
      return <label key={key}>{labels[key]}<input type="number" required={!optional}
        min={rule.minimum} max={rule.maximum} step={rule.type === 'integer' ? 1 : 'any'}
        placeholder={optional ? '使用节点本地设置' : undefined} value={values[key] == null ? '' : String(values[key])}
        onChange={e => {
          const current = e.target.value === '' ? (optional ? undefined : '') : Number(e.target.value);
          if (optional) updateEngine(key, current); else onChange({...value, [key]: current});
        }}/><small className="muted">{rule.minimum}–{rule.maximum}{optional && ' · 可留空'}</small></label>;
    });
  }
  return <>
    <div className="config-grid">{fields(pool ? {execution_slots: {type: 'integer', minimum: 1, maximum: schema.pool_limits[pool]}} : schema.node.properties, value)}</div>
    {!pool && <>
      <section className="config-section"><h3>目标语言</h3>
        {!wholePage && <label className="check-label"><input type="checkbox" checked={engine.languages == null}
          onChange={e => updateEngine('languages', e.target.checked ? undefined : [...selected])}/>使用节点本地语言设置</label>}
        <p className="muted">{wholePage ? '中心只派发所选语言与节点实际支持语言的交集。' : '取消勾选后，所选语言会覆盖本地设置。'}当前选中 {selected.length} / {schema.languages.length}。</p>
        <fieldset disabled={!wholePage && engine.languages == null} className="language-options">
          <legend className="sr-only">支持的目标语言</legend>
          <div className="language-actions"><button type="button" className="text-link" onClick={() => updateLanguages(schema.languages.map(l => l.id))}>全选语言</button>
            <button type="button" className="text-link" onClick={() => updateLanguages([])}>清空选择</button></div>
          <div className="language-grid">{schema.languages.map(language => <label className="language-option" key={language.id}>
            <input type="checkbox" checked={selected.includes(language.id)} onChange={e => updateLanguages(e.target.checked ? [...selected, language.id] : selected.filter(code => code !== language.id))}/>
            <span>{language.label}<small>{language.id}</small></span></label>)}</div>
        </fieldset>
      </section>
      {!wholePage && <section className="config-section"><h3>引擎线程与缓存</h3><p className="muted">可选覆盖项；留空使用节点本地文件设置。</p>
        <div className="config-grid">{fields(schema.engine.properties, engine, true)}</div></section>}
    </>}
  </>;
}
