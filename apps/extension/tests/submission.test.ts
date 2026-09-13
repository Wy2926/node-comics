import {describe,it,expect} from 'vitest';
import {ApiError,submissionRejected} from '../src/api';
describe('reconciling persistent submission intents',()=>{
it('allows fresh estimation after the server definitively rejected an expired quote',()=>{expect(submissionRejected(new ApiError('expired','QUOTE_EXPIRED',409))).toBe(true);expect(submissionRejected(new ApiError('changed','QUOTE_CHANGED',409))).toBe(true);});
it('retains the same operation for uncertain outcomes and conflicting idempotency keys',()=>{expect(submissionRejected(new ApiError('offline','NETWORK_ERROR'))).toBe(false);expect(submissionRejected(new ApiError('unknown','UPSTREAM_OUTCOME_UNKNOWN',502))).toBe(false);expect(submissionRejected(new ApiError('conflict','IDEMPOTENCY_CONFLICT',409))).toBe(false);});
});
