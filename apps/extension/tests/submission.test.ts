import {afterEach,describe,it,expect,vi} from 'vitest';
import {Api,ApiError,submissionRejected} from '../src/api';
afterEach(()=>vi.unstubAllGlobals());
describe('reconciling persistent submission intents',()=>{
it('allows a fresh capacity check after a definitive submission rejection',()=>{expect(submissionRejected(new ApiError('full','QUEUE_CAPACITY_EXCEEDED',409))).toBe(true);expect(submissionRejected(new ApiError('quota','QUOTA_BOUND_EXCEEDED',409))).toBe(true);});
it('retains the same operation for uncertain outcomes and conflicting idempotency keys',()=>{expect(submissionRejected(new ApiError('offline','NETWORK_ERROR'))).toBe(false);expect(submissionRejected(new ApiError('unknown','UPSTREAM_OUTCOME_UNKNOWN',502))).toBe(false);expect(submissionRejected(new ApiError('conflict','IDEMPOTENCY_CONFLICT',409))).toBe(false);});
it.each([{body:120,header:'60',expected:120},{body:undefined,header:'75',expected:75},{body:undefined,header:'invalid',expected:undefined}])('reads throttling delay from structured error or Retry-After: $expected',async({body,header,expected})=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({error:{code:'SUBMISSION_RATE_LIMITED',message:'稍后重试',retry_after_seconds:body}}),{status:429,headers:{'Retry-After':header}})));
 await expect(new Api('https://api.example').request('/v1/translation-submissions')).rejects.toMatchObject({status:429,code:'SUBMISSION_RATE_LIMITED',retryAfterSeconds:expected});
});
});
