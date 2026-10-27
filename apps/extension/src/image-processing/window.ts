import {ReadingWindow} from '../reading-window';
import type {ProcessingInput, ProcessingProfile, ProcessingImage} from './contracts';
import {enhanceImage} from './runtime';

export interface ProcessingTarget {id: string; input?: ProcessingInput; sourceKey?: string;}
interface Work {target: ProcessingTarget; profile: ProcessingProfile; image: ProcessingImage; controller?: AbortController;}
const identity = (target: ProcessingTarget, profile: ProcessingProfile, revision?: string) =>
  JSON.stringify([target.input?.owner, target.input?.key, target.sourceKey, profile.id, profile.revision, revision]);

/** Owns bounded processing independently of mounted/decoded images. The runtime owns service serialization and durable receipts. */
export class ProcessingWindow {
  private window = new ReadingWindow<ProcessingTarget>(target => target.id);
  private work = new Map<string, Work>();
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly changed: () => void) {}

  image(target: ProcessingTarget, profile?: ProcessingProfile, revision?: string): ProcessingImage | undefined {
    if (!target.input || !profile) return;
    const key = identity(target, profile, revision), work = this.work.get(target.id);
    return work?.image.identity === key ? work.image : {identity: key, retry: () => this.retry(target.id, key)};
  }

  update(targets: ProcessingTarget[], profile?: ProcessingProfile, revision?: string, immediate = false) {
    this.window.update(targets, performance.now(), immediate);
    const wanted = new Map(this.window.targets.filter(target => target.input && profile).map(target => [target.id, target]));
    let changed = false;
    for (const [id, work] of this.work) {
      const target = wanted.get(id);
      if (!target || work.image.identity !== identity(target, profile!, revision)) {
        work.controller?.abort(); this.work.delete(id); changed = true;
      }
    }
    for (const [id, target] of wanted) {
      const current = this.work.get(id);
      if (current) current.target = target;
      else {this.work.set(id, {target, profile: profile!, image: this.image(target, profile, revision)!}); changed = true;}
    }
    this.flush();
    if (changed) this.changed();
  }

  private flush = () => {
    clearTimeout(this.timer);
    const now=performance.now();
    for (const target of this.window.ready(now)) {
      const work = this.work.get(target.id);
      if (work && !work.controller) this.start(work);
    }
    const delay = this.window.delay(now);
    if (this.work.size && delay > 0) this.timer = setTimeout(this.flush, delay);
  };

  private start(work: Work, retry = false) {
    work.controller?.abort();
    const controller = work.controller = new AbortController();
    const change = (value: Partial<ProcessingImage>) => {
      if (controller.signal.aborted) return;
      work.image = {...work.image, ...value}; this.changed();
    };
    void enhanceImage(work.target.input!, work.profile, controller.signal, {retry,
      onState: state => {if (state.phase !== 'ready') change({state});},
    }).then(blob => change({blob, state: {phase: 'ready'}}))
      .catch(error => change({state: {phase: 'error', message: (error as Error).message}}));
  }

  private retry(id: string, identity: string) {
    const work = this.work.get(id);
    if (work?.image.identity === identity) this.start(work, true);
  }

  clear() {
    clearTimeout(this.timer);
    for (const work of this.work.values()) work.controller?.abort();
    this.work.clear();
    this.window.update([]);
  }
}
