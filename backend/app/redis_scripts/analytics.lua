local clock = redis.call('TIME')
local now = tonumber(ARGV[1]) or (clock[1] * 1000 + math.floor(clock[2] / 1000))
local token, cost, capacity, maximum, ttl = ARGV[2], tonumber(ARGV[3]), tonumber(ARGV[4]), tonumber(ARGV[5]), tonumber(ARGV[6])
-- Charge rejected/replayed envelopes too, but only reach the global bucket after per-client limits.
local budgets = {{120, 2, 1}, {30, .5, 1}, {300, 5, cost}, {600, 100, cost}}
for i, budget in ipairs(budgets) do
    local old = redis.call('HMGET', KEYS[i], 'tokens', 'at')
    local at = math.max(now, tonumber(old[2]) or now)
    local tokens = math.min(budget[1], (tonumber(old[1]) or budget[1]) + (at - (tonumber(old[2]) or at)) * budget[2] / 1000)
    local allowed = tokens >= budget[3]
    redis.call('HSET', KEYS[i], 'tokens', allowed and tokens - budget[3] or tokens, 'at', at)
    redis.call('PEXPIRE', KEYS[i], math.ceil(budget[1] / budget[2] * 1000))
    if not allowed then return {-1} end
end
redis.call('ZREMRANGEBYSCORE', KEYS[6], '-inf', now)
if redis.call('ZCARD', KEYS[6]) >= capacity then return {-2} end
redis.call('ZREMRANGEBYSCORE', KEYS[5], '-inf', now - ttl)
local result = {0}
for i = 7, #ARGV do
    if not redis.call('ZSCORE', KEYS[5], ARGV[i]) then
        redis.call('ZADD', KEYS[5], now, ARGV[i])
        result[#result + 1] = i - 6
    end
end
local excess = redis.call('ZCARD', KEYS[5]) - maximum
if excess > 0 then redis.call('ZREMRANGEBYRANK', KEYS[5], 0, excess - 1) end
redis.call('PEXPIRE', KEYS[5], ttl)
if #result > 1 then
    result[1] = 1
    -- The GA transport has a hard 2-second deadline; TTL also releases a crashed replica.
    redis.call('ZADD', KEYS[6], now + 10000, token)
    redis.call('PEXPIRE', KEYS[6], 10000)
end
return result
