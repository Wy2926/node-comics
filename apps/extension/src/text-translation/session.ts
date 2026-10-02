import {TextTranslationError, type TextTranslationAdapter} from './contracts';

interface Listener {resolve: (value: string) => void; reject: (error: unknown) => void; cleanup: () => void;}
interface Job {key: string; text: string; language: string; controller: AbortController; listeners: Set<Listener>;}
/** Two active fields, bounded waiting queue and exact-input cache for one discovery page. */
export class TextTranslationSession {
  private cache = new Map<string, string>();
  private cacheSize = 0;
  private jobs = new Map<string, Job>();
  private queue: Job[] = [];
  private active = 0;
  constructor(private adapter: TextTranslationAdapter) {}
  translate(text: string, language: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const key = JSON.stringify([this.adapter.id, language, text]), cached = this.cache.get(key);
    if (cached !== undefined) {
      this.cache.delete(key); this.cache.set(key, cached);
      return Promise.resolve(cached);
    }
    let job = this.jobs.get(key);
    if (!job) {
      if (this.jobs.size >= 40) return Promise.reject(new TextTranslationError('unavailable'));
      job = {key, text, language, controller: new AbortController(), listeners: new Set()};
      this.jobs.set(key, job); this.queue.push(job);
    }
    const current = job;
    const promise = new Promise<string>((resolve, reject) => {
      const abort = () => {
        current.listeners.delete(listener); listener.cleanup(); reject(signal.reason);
        if (!current.listeners.size) {
          current.controller.abort();
          if (this.jobs.get(key) === current) this.jobs.delete(key);
          this.queue = this.queue.filter(value => value !== current);
        }
      };
      const listener: Listener = {resolve, reject, cleanup: () => signal.removeEventListener('abort', abort)};
      current.listeners.add(listener);
      signal.addEventListener('abort', abort, {once: true});
    });
    this.pump(); return promise;
  }
  private pump() {
    while (this.active < 2 && this.queue.length) {
      const job = this.queue.shift()!;
      if (!job.listeners.size) continue;
      this.active++;
      void Promise.resolve().then(() => this.adapter.translate(job.text, job.language, job.controller.signal)).then(result => {
        if (job.controller.signal.aborted) return;
        if (!result.trim() || result.length > 64_000) throw new TextTranslationError('invalid');
        this.cache.set(job.key, result); this.cacheSize += job.key.length + result.length;
        while (this.cache.size > 120 || this.cacheSize > 512_000) {
          const [key, value] = this.cache.entries().next().value!;
          this.cache.delete(key); this.cacheSize -= key.length + value.length;
        }
        if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
        job.listeners.forEach(listener => listener.resolve(result));
      }).catch(error => {
        if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
        job.listeners.forEach(listener => listener.reject(error));
      }).finally(() => {
        job.listeners.forEach(listener => listener.cleanup()); job.listeners.clear();
        this.active--; this.pump();
      });
    }
  }
  cancel() {
    for (const job of this.jobs.values()) {
      job.controller.abort();
      job.listeners.forEach(listener => {listener.cleanup(); listener.reject(new DOMException('Cancelled', 'AbortError'));});
      job.listeners.clear();
    }
    this.jobs.clear(); this.queue = [];
  }
  dispose() {this.cancel(); this.cache.clear(); this.cacheSize = 0;}
}
