local clock = redis.call('TIME')
local now = tonumber(ARGV[1]) or (clock[1] * 1000 + math.floor(clock[2] / 1000))
local rate, burst, capacity, lease, member, daily = tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4]), tonumber(ARGV[5]), ARGV[6], tonumber(ARGV[7])
local old = redis.call('HMGET', KEYS[1], 'tokens', 'at', 'day', 'receipts')
local at = math.max(now, tonumber(old[2]) or now)
local tokens = math.min(burst, (tonumber(old[1]) or burst) + (at - (tonumber(old[2]) or at)) * rate / 60000)
local day = math.floor(at / 86400000) * 86400000
local receipts = tonumber(old[3]) == day and (tonumber(old[4]) or 0) or 0
if tonumber(old[3]) ~= day then redis.call('DEL', KEYS[3]) end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', at)
local active = redis.call('ZCARD', KEYS[2])
local retry, allowed, reason = 0, 1, ''
if member ~= '' and daily > 0 and redis.call('SISMEMBER', KEYS[3], member) == 1 then
    return {1, 0, tostring(tokens), at, active, receipts, day, ''}
end
if member ~= '' then
    if capacity > 0 and active >= capacity then
        retry, allowed, reason = 1, 0, 'concurrency'
    elseif tokens < 1 then
        retry, allowed, reason = math.max(1, math.ceil((1 - tokens) * 60 / rate)), 0, 'rate'
    elseif daily > 0 and receipts >= daily then
        tokens = tokens - 1
        retry, allowed, reason = math.max(1, math.ceil((day + 86400000 - at) / 1000)), 0, 'daily'
    else
        tokens = tokens - 1
        if daily > 0 then
            receipts = receipts + 1
            redis.call('SADD', KEYS[3], member)
            redis.call('PEXPIRE', KEYS[3], day + 86400000 - at)
        end
        if capacity > 0 then
            redis.call('ZADD', KEYS[2], at + lease, member)
            redis.call('PEXPIRE', KEYS[2], tonumber(redis.call('ZREVRANGE', KEYS[2], 0, 0, 'WITHSCORES')[2]) - at)
            active = active + 1
        end
    end
    redis.call('HSET', KEYS[1], 'tokens', tokens, 'at', at, 'day', day, 'receipts', receipts)
    redis.call('PEXPIRE', KEYS[1], math.max(lease, math.ceil(burst * 60000 / rate), daily > 0 and (day + 86400000 - at) or 0))
end
return {allowed, retry, tostring(tokens), at, active, receipts, day, reason}
