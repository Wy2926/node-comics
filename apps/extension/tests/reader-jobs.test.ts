import {describe,expect,it} from 'vitest';
import {mergeJobs} from '../src/reader/jobs';
import type {Job} from '../src/types';

const job = (status: Job['status'], extra: Partial<Job> = {}): Job => ({ id: 'job', result:status==='succeeded'?{key:'result',recoverable:true}:undefined,   mode: 'classic', target_language: 'zh-Hans', status, phase: '', quota_pages: 1, created_at: '2026-09-14T00:00:00Z', version: 1, cache_hit: false, ...extra });

describe('translation result versions', () => {
  it('never lets older pending state revive a completed or removed result', () => {
    expect(mergeJobs([job('succeeded')], [job('running')])[0].status).toBe('succeeded');
    expect(mergeJobs([job('outcome_unknown')], [job('queued')])[0].status).toBe('outcome_unknown');
    expect(mergeJobs([job('succeeded', { result:undefined})], [job('succeeded', { })])[0]).toMatchObject({  result_available: false, result_expired: true });
  });
  it('applies revoked authorization regardless of execution timestamps and prevents late revival',()=>{
    const revoked=job('failed',{result_expired:true,error:{code:'TRANSLATION_UNAVAILABLE',message:'unavailable'}});
    const merged=mergeJobs([job('succeeded')],[revoked]);expect(merged[0].result_expired).toBe(true);expect(merged[0].result).toBeUndefined();expect(mergeJobs(merged,[job('succeeded')])[0].result).toBeUndefined();
  });
  it('retains independent versions from different configurations', () => {
    const old = job('succeeded', { id: 'old-config', version: 2, created_at: '2026-09-13T00:00:00Z' });
    const newer = job('succeeded', { id: 'new-config', version: 1, created_at: '2026-09-14T00:00:00Z' });
    expect(mergeJobs([old], [newer]).map(item => item.id)).toEqual(['old-config', 'new-config']);
  });
});
