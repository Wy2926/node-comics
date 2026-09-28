local clock = redis.call('TIME')
local now = tonumber(ARGV[1]) or (clock[1] * 1000 + math.floor(clock[2] / 1000))
local operation, token, duration = ARGV[2], ARGV[3], tonumber(ARGV[4])
local current = redis.call('GET', KEYS[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
if current and not redis.call('ZSCORE', KEYS[1], current) then
    redis.call('DEL', KEYS[3])
    current = false
end
if operation == 'acquire' then
    if current or redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[5]) or redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[6]) then return 0 end
elseif current ~= token or not redis.call('ZSCORE', KEYS[1], token) then
    return 0
end
if operation == 'release' then
    redis.call('DEL', KEYS[3])
    redis.call('ZREM', KEYS[1], token)
    redis.call('ZREM', KEYS[2], token)
elseif operation ~= 'check' then
    redis.call('SET', KEYS[3], token, 'PX', duration)
    redis.call('ZADD', KEYS[1], now + duration, token)
    redis.call('ZADD', KEYS[2], now + duration, token)
    local ttl = tonumber(redis.call('ZREVRANGE', KEYS[1], 0, 0, 'WITHSCORES')[2]) - now
    redis.call('PEXPIRE', KEYS[1], ttl)
    ttl = tonumber(redis.call('ZREVRANGE', KEYS[2], 0, 0, 'WITHSCORES')[2]) - now
    redis.call('PEXPIRE', KEYS[2], ttl)
end
return 1
