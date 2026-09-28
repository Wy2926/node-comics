local clock = redis.call('TIME')
local now = tonumber(ARGV[1]) or (clock[1] * 1000 + math.floor(clock[2] / 1000))
local result = {redis.call('ZCOUNT', KEYS[2], '(' .. now, '+inf')}
for i = 3, #KEYS do
    local token = redis.call('GET', KEYS[i])
    local deadline = token and tonumber(redis.call('ZSCORE', KEYS[1], token)) or 0
    result[#result + 1] = deadline and deadline > now and deadline or 0
end
return result
