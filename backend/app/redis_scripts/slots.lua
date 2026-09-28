local clock = redis.call('TIME')
local now = tonumber(ARGV[1]) or (clock[1] * 1000 + math.floor(clock[2] / 1000))
local operation, token, capacity, duration = ARGV[2], ARGV[3], tonumber(ARGV[4]), tonumber(ARGV[5])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if operation == 'release' then return redis.call('ZREM', KEYS[1], token) end
if operation == 'acquire' then
    if redis.call('ZCARD', KEYS[1]) >= capacity then return 0 end
elseif not redis.call('ZSCORE', KEYS[1], token) then
    return 0
end
redis.call('ZADD', KEYS[1], now + duration, token)
redis.call('PEXPIRE', KEYS[1], tonumber(redis.call('ZREVRANGE', KEYS[1], 0, 0, 'WITHSCORES')[2]) - now)
return 1
