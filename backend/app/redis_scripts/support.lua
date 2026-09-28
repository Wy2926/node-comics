local clock = redis.call('TIME')
local now = tonumber(ARGV[1]) or (clock[1] * 1000 + math.floor(clock[2] / 1000))
local old = redis.call('HMGET', KEYS[1], 'minute', 'count', 'day', 'daily')
local minute, count = tonumber(old[1]) or now, tonumber(old[2]) or 0
local day = math.floor(now / 86400000) * 86400000
local daily = tonumber(old[3]) == day and (tonumber(old[4]) or 0) or 0
if now >= minute + 60000 then minute, count = now, 0 end
if tonumber(old[3]) ~= day then redis.call('DEL', KEYS[2]) end
if redis.call('SISMEMBER', KEYS[2], ARGV[2]) == 1 then return 0 end
if daily >= 20 then return math.max(1, math.ceil((day + 86400000 - now) / 1000)) end
if count >= 5 then return math.max(1, math.ceil((minute + 60000 - now) / 1000)) end
redis.call('HSET', KEYS[1], 'minute', minute, 'count', count + 1, 'day', day, 'daily', daily + 1)
redis.call('PEXPIRE', KEYS[1], math.max(60000, day + 86400000 - now))
redis.call('SADD', KEYS[2], ARGV[2])
redis.call('PEXPIRE', KEYS[2], day + 86400000 - now)
return 0
