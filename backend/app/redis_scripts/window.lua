local clock = redis.call('TIME')
local now = tonumber(ARGV[1]) or (clock[1] * 1000 + math.floor(clock[2] / 1000))
local limit, window, member = tonumber(ARGV[2]), tonumber(ARGV[3]), ARGV[4]
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local count = redis.call('ZCARD', KEYS[1])
local last = redis.call('ZREVRANGE', KEYS[1], 0, 0, 'WITHSCORES')
local retry = 0
if member ~= '' and redis.call('ZSCORE', KEYS[1], member) then
    return {count, 0, now, tonumber(last[2]) or 0}
end
if count >= limit then
    local boundary = redis.call('ZRANGE', KEYS[1], count - limit, count - limit, 'WITHSCORES')
    retry = math.max(1, math.ceil((boundary[2] + window - now) / 1000))
elseif member ~= '' then
    redis.call('ZADD', KEYS[1], now, member)
    redis.call('PEXPIRE', KEYS[1], window)
    count = count + 1
    last = {member, now}
end
return {count, retry, now, tonumber(last[2]) or 0}
