import { sanitizeEvent, type AnalyticsEvent, type AnalyticsEventName } from './schema';

export const analyticsStorageKey = 'nc-analytics-v1';
export const analyticsLimits = {
  queue: 200,
  batch: 20,
  ageMs: 24 * 60 * 60 * 1000,
  sessionMs: 30 * 60 * 1000,
  attempts: 5,
} as const;

interface QueuedEvent extends AnalyticsEvent {
  session_id: number;
  attempts: number;
  next_attempt: number;
}
export interface AnalyticsState {
  consent: boolean;
  consented_at?: number;
  client_id?: string;
  session_id?: number;
  last_active?: number;
  first_use?: boolean;
  activated?: boolean;
  queue: QueuedEvent[];
}
interface Dependencies {
  read: () => Promise<AnalyticsState | undefined>;
  write: (state: AnalyticsState) => Promise<void>;
  allowed: () => Promise<boolean>;
  send: (body: unknown, signal: AbortSignal) => Promise<number>;
  common: () => Record<string, string>;
  wake: (delay: number) => void;
  clearWake: () => void;
  now?: () => number;
  uuid?: () => string;
}
const empty = (): AnalyticsState => ({ consent: false, queue: [] });
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Background is the only writer, including across popup/reader tabs. */
export function createAnalyticsEngine(deps: Dependencies) {
  const now = deps.now ?? Date.now;
  const uuid = deps.uuid ?? (() => crypto.randomUUID());
  let serial = Promise.resolve();
  let sending: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let generation = 0;
  const lock = <T>(work: () => Promise<T>): Promise<T> => {
    const run = serial.then(work, work);
    serial = run.then(() => {}, () => {});
    return run;
  };

  async function state(): Promise<AnalyticsState> {
    const value = await deps.read();
    if (value?.consent !== true)
      return empty();
    const consentedAt = typeof value.consented_at === 'number' && Number.isSafeInteger(value.consented_at) && value.consented_at >= 0
      ? value.consented_at : now();
    const queue = Array.isArray(value.queue) && (!value.client_id || uuidPattern.test(value.client_id)) ? value.queue : [];
    const normalized = {
      ...value,
      consented_at: consentedAt,
      queue: queue.filter(event => {
        if (!event || typeof event !== 'object')
          return false;
        const age = now() - event.timestamp_micros / 1000;
        return uuidPattern.test(event.event_id)
          && Number.isSafeInteger(event.session_id) && event.session_id > 0
          && Number.isSafeInteger(event.timestamp_micros)
          && age >= -60000 && age < analyticsLimits.ageMs
          && Number.isSafeInteger(event.attempts)
          && event.attempts >= 0 && event.attempts < analyticsLimits.attempts
          && Number.isFinite(event.next_attempt) && event.next_attempt >= 0
          && sanitizeEvent(event.name, event.params);
      }).slice(-analyticsLimits.queue).map(event => ({
        ...event,
        params: sanitizeEvent(event.name, event.params)!.params,
      })),
    };
    if (consentedAt !== value.consented_at || JSON.stringify(normalized.queue) !== JSON.stringify(queue))
      await deps.write(normalized);
    return normalized;
  }

  async function allowedState(): Promise<AnalyticsState> {
    const value = await state();
    if (!value.consent)
      return value;
    if (await deps.allowed())
      return value;
    controller?.abort();
    deps.clearWake();
    await deps.write(empty());
    return empty();
  }

  async function enabled(): Promise<boolean> {
    return lock(async () => (await allowedState()).consent);
  }

  async function setConsent(consent: boolean): Promise<boolean> {
    // Revocation interrupts a network request before waiting for any storage operation.
    if (!consent) {
      generation++;
      controller?.abort();
      deps.clearWake();
    }
    return lock(async () => {
      const permitted = consent && await deps.allowed();
      if (!permitted) {
        if (consent) {
          generation++;
          controller?.abort();
          deps.clearWake();
        }
        await deps.write(empty());
        return false;
      }
      const previous = await state();
      if (previous.consent)
        return true;
      generation++;
      await deps.write({ ...previous, consent: true, consented_at: now() });
      return true;
    });
  }

  async function track(name: AnalyticsEventName, params: Record<string, string | number>, startedAt = now()): Promise<void> {
    if (!Number.isSafeInteger(startedAt) || startedAt < 0)
      return;
    const clean = sanitizeEvent(name, params);
    if (!clean)
      return;
    await lock(async () => {
      const value = await allowedState();
      if (!value.consent)
        return;
      const at = now();
      // Task start time stays local: old work cannot cross a new consent boundary.
      if (startedAt < value.consented_at! || startedAt > at)
        return;
      if (!value.client_id || !uuidPattern.test(value.client_id))
        value.client_id = uuid();
      if (!value.session_id || !value.last_active || at - value.last_active >= analyticsLimits.sessionMs)
        value.session_id = Math.floor(at / 1000);
      value.last_active = at;
      const add = (eventName: AnalyticsEventName, eventParams: Record<string, string | number>) => {
        const event = sanitizeEvent(eventName, { ...eventParams, ...deps.common() })!;
        value.queue.push({
          ...event,
          event_id: uuid(),
          session_id: value.session_id!,
          timestamp_micros: at * 1000,
          attempts: 0,
          next_attempt: at,
        });
      };
      if (!value.first_use) {
        value.first_use = true;
        add('extension_first_use', { surface: clean.params.surface ?? 'reader', ui_language: clean.params.ui_language ?? 'en' });
      }
      if (clean.name !== 'extension_first_use' && clean.name !== 'reader_activated')
        add(clean.name, clean.params);
      if (clean.name === 'reading_engaged' && !value.activated) {
        value.activated = true;
        add('reader_activated', clean.params);
      }
      value.queue = value.queue.slice(-analyticsLimits.queue);
      await deps.write(value);
      deps.wake(3000);
    });
  }

  async function runFlush(): Promise<void> {
    const epoch = generation;
    const batch = await lock(async () => {
      const value = await allowedState();
      if (!value.consent || !value.client_id || !uuidPattern.test(value.client_id) || !value.queue.length)
        return;
      const due = value.queue.filter(event => event.next_attempt <= now());
      const session = due[0]?.session_id;
      if (!session) {
        deps.wake(Math.max(1000, Math.min(...value.queue.map(event => event.next_attempt)) - now()));
        return;
      }
      const events = due.filter(event => event.session_id === session).slice(0, analyticsLimits.batch);
      return { client_id: value.client_id, session_id: session, events };
    });
    if (!batch || epoch !== generation)
      return;
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), 8000);
    let status = 0;
    try {
      if (epoch !== generation)
        return;
      if (!await deps.allowed()) {
        await setConsent(false);
        return;
      }
      if (epoch !== generation)
        return;
      status = await deps.send({
        ...batch,
        events: batch.events.map(({ event_id, name, params, timestamp_micros }) => ({
          event_id, name, params, timestamp_micros,
        })),
      }, controller.signal);
    } catch {
      // Network failure remains bounded and never reaches the product UI.
    } finally {
      clearTimeout(timeout);
      controller = undefined;
    }
    await lock(async () => {
      const value = await allowedState();
      if (!value.consent || value.client_id !== batch.client_id || epoch !== generation)
        return;
      const ids = new Set(batch.events.map(event => event.event_id));
      const drop = status >= 200 && status < 300 || status >= 400 && status < 500 && status !== 408 && status !== 429;
      value.queue = value.queue.flatMap(event => {
        if (!ids.has(event.event_id))
          return [event];
        if (drop || event.attempts + 1 >= analyticsLimits.attempts)
          return [];
        return [{
          ...event,
          attempts: event.attempts + 1,
          next_attempt: now() + Math.min(60 * 60 * 1000, 30000 * 2 ** event.attempts),
        }];
      });
      await deps.write(value);
      if (value.queue.length)
        deps.wake(Math.max(1000, Math.min(...value.queue.map(event => event.next_attempt)) - now()));
      else
        deps.clearWake();
    });
  }

  function flush(): Promise<void> {
    return sending ??= runFlush().finally(() => {sending = undefined;});
  }

  return { track, enabled, setConsent, flush };
}
