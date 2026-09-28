local clock = redis.call('TIME')
local now = tonumber(ARGV[1]) or (clock[1] * 1000 + math.floor(clock[2] / 1000))
local result = {}
for i, key in ipairs(KEYS) do
    result[i] = redis.call('ZCOUNT', key, '(' .. (now - 60000), '+inf') < tonumber(ARGV[i + 1]) and 1 or 0
end
return result
