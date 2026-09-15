import {describe,it,expect} from 'vitest';
import {ApiError,submissionRejected} from '../src/api';
describe('reconciling persistent submission intents',()=>{
it('allows a fresh capacity check after a definitive submission rejection',()=>{expect(submissionRejected(new ApiError('full','QUEUE_CAPACITY_EXCEEDED',409))).toBe(true);expect(submissionRejected(new ApiError('quota','QUOTA_BOUND_EXCEEDED',409))).toBe(true);});
it('retains the same operation for uncertain outcomes and conflicting idempotency keys',()=>{expect(submissionRejected(new ApiError('offline','NETWORK_ERROR'))).toBe(false);expect(submissionRejected(new ApiError('unknown','UPSTREAM_OUTCOME_UNKNOWN',502))).toBe(false);expect(submissionRejected(new ApiError('conflict','IDEMPOTENCY_CONFLICT',409))).toBe(false);});
});
