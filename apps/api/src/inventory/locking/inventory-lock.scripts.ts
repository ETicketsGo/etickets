/**
 * Atomic Redis Lua scripts for the inventory-lock engine (ADR-039). Each script runs
 * as a single atomic Redis operation — there is NO get-then-check-then-set race. All
 * keys are passed in explicitly (no in-script key construction) and lock metadata is
 * stored as JSON (epoch-ms timestamps; the service maps them to ISO for the contract).
 *
 * Return shape is always a 2-element array: [status, payload].
 */

/**
 * SEAT acquire — all-or-nothing, idempotent, fenced.
 * KEYS: [idempKey, fenceKey, lockKey, seatKey_1 … seatKey_N]
 * ARGV: [lockId, holdId, ownerId, anon, inventoryType, inventoryKey, ttl, nowMs,
 *        fingerprint, correlationId, bookingId, providerCode, seatIdsCsv, fenceTtl]
 * status ∈ ACQUIRED | REPLAY | CONFLICT | IDEMPOTENCY_CONFLICT
 */
export const SEAT_ACQUIRE = `
local idempKey, fenceKey, lockKey = KEYS[1], KEYS[2], KEYS[3]
local seatStart = 4
local lockId = ARGV[1]
local ttl = tonumber(ARGV[7])
local nowMs = tonumber(ARGV[8])
local fingerprint = ARGV[9]
local fenceTtl = tonumber(ARGV[14])

local existing = redis.call('GET', idempKey)
if existing then
  local ok, lock = pcall(cjson.decode, existing)
  if ok and lock.fingerprint == fingerprint then return {'REPLAY', existing} end
  return {'IDEMPOTENCY_CONFLICT', ''}
end

for i = seatStart, #KEYS do
  local owner = redis.call('GET', KEYS[i])
  if owner and owner ~= lockId then return {'CONFLICT', KEYS[i]} end
end

local token = redis.call('INCR', fenceKey)
redis.call('EXPIRE', fenceKey, fenceTtl)

local seatIds = {}
for s in string.gmatch(ARGV[13], '([^,]+)') do seatIds[#seatIds + 1] = s end

local lock = {
  lockId = lockId, holdId = ARGV[2], inventoryType = ARGV[5], inventoryKey = ARGV[6],
  status = 'ACTIVE', fencingToken = token, ttlSeconds = ttl, acquiredAtMs = nowMs,
  expiresAtMs = nowMs + ttl * 1000, fingerprint = fingerprint, inventoryUnitIds = seatIds
}
if ARGV[3] ~= '' then lock.ownerId = ARGV[3] end
if ARGV[4] ~= '' then lock.anonymousSessionId = ARGV[4] end
if ARGV[10] ~= '' then lock.correlationId = ARGV[10] end
if ARGV[11] ~= '' then lock.bookingId = ARGV[11] end
if ARGV[12] ~= '' then lock.providerCode = ARGV[12] end

local encoded = cjson.encode(lock)
for i = seatStart, #KEYS do redis.call('SET', KEYS[i], lockId, 'EX', ttl) end
redis.call('SET', lockKey, encoded, 'EX', ttl)
redis.call('SET', idempKey, encoded, 'EX', ttl)
return {'ACQUIRED', encoded}
`;

/**
 * QUANTITY acquire — capacity-bounded, idempotent, fenced. Held quantity is derived
 * from a ZSET (member=lockId, score=expiryMs) + HASH (lockId→qty), with expired
 * members purged lazily each acquire, so held quantity can never be stale-inflated and
 * a Redis TTL never leaves a phantom hold in the sum.
 * KEYS: [idempKey, fenceKey, lockKey, qtyZset, qtyHash]
 * ARGV: [lockId, holdId, ownerId, anon, inventoryKey, ttl, nowMs, fingerprint,
 *        correlationId, bookingId, providerCode, requestedQty, capacity, fenceTtl]
 * status ∈ ACQUIRED | REPLAY | CAPACITY | IDEMPOTENCY_CONFLICT
 */
export const QUANTITY_ACQUIRE = `
local idempKey, fenceKey, lockKey, zsetKey, hashKey = KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5]
local lockId = ARGV[1]
local ttl = tonumber(ARGV[6])
local nowMs = tonumber(ARGV[7])
local fingerprint = ARGV[8]
local req = tonumber(ARGV[12])
local cap = tonumber(ARGV[13])
local fenceTtl = tonumber(ARGV[14])

local existing = redis.call('GET', idempKey)
if existing then
  local ok, lock = pcall(cjson.decode, existing)
  if ok and lock.fingerprint == fingerprint then return {'REPLAY', existing} end
  return {'IDEMPOTENCY_CONFLICT', ''}
end

local expired = redis.call('ZRANGEBYSCORE', zsetKey, '-inf', '(' .. nowMs)
for _, m in ipairs(expired) do redis.call('HDEL', hashKey, m) end
if #expired > 0 then redis.call('ZREMRANGEBYSCORE', zsetKey, '-inf', '(' .. nowMs) end

local held = 0
for _, v in ipairs(redis.call('HVALS', hashKey)) do held = held + tonumber(v) end
if held + req > cap then return {'CAPACITY', tostring(held)} end

local token = redis.call('INCR', fenceKey)
redis.call('EXPIRE', fenceKey, fenceTtl)
local expiresAtMs = nowMs + ttl * 1000
redis.call('ZADD', zsetKey, expiresAtMs, lockId)
redis.call('HSET', hashKey, lockId, req)
redis.call('EXPIRE', zsetKey, fenceTtl)
redis.call('EXPIRE', hashKey, fenceTtl)

local lock = {
  lockId = lockId, holdId = ARGV[2], inventoryType = 'QUANTITY', inventoryKey = ARGV[5],
  status = 'ACTIVE', fencingToken = token, ttlSeconds = ttl, acquiredAtMs = nowMs,
  expiresAtMs = expiresAtMs, fingerprint = fingerprint, quantity = req
}
if ARGV[3] ~= '' then lock.ownerId = ARGV[3] end
if ARGV[4] ~= '' then lock.anonymousSessionId = ARGV[4] end
if ARGV[9] ~= '' then lock.correlationId = ARGV[9] end
if ARGV[10] ~= '' then lock.bookingId = ARGV[10] end
if ARGV[11] ~= '' then lock.providerCode = ARGV[11] end

local encoded = cjson.encode(lock)
redis.call('SET', lockKey, encoded, 'EX', ttl)
redis.call('SET', idempKey, encoded, 'EX', ttl)
return {'ACQUIRED', encoded}
`;

/**
 * SEAT renew — validates active + fencing token, extends TTL across all seat keys +
 * lock metadata atomically.
 * KEYS: [lockKey, seatKey_1 … seatKey_N]   ARGV: [lockId, expectedToken, ttl, nowMs]
 * status ∈ RENEWED | NOT_FOUND | NOT_ACTIVE | TOKEN_STALE
 */
export const SEAT_RENEW = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {'NOT_FOUND', ''} end
local lock = cjson.decode(raw)
if lock.status ~= 'ACTIVE' then return {'NOT_ACTIVE', lock.status} end
if tostring(lock.fencingToken) ~= ARGV[2] then return {'TOKEN_STALE', tostring(lock.fencingToken)} end
local ttl = tonumber(ARGV[3])
local nowMs = tonumber(ARGV[4])
lock.expiresAtMs = nowMs + ttl * 1000
lock.lastRenewedAtMs = nowMs
for i = 2, #KEYS do redis.call('EXPIRE', KEYS[i], ttl) end
redis.call('SET', KEYS[1], cjson.encode(lock), 'EX', ttl)
return {'RENEWED', cjson.encode(lock)}
`;

/**
 * QUANTITY renew — validates active + fencing token, extends lock TTL + ZSET score.
 * KEYS: [lockKey, qtyZset]   ARGV: [lockId, expectedToken, ttl, nowMs]
 */
export const QUANTITY_RENEW = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {'NOT_FOUND', ''} end
local lock = cjson.decode(raw)
if lock.status ~= 'ACTIVE' then return {'NOT_ACTIVE', lock.status} end
if tostring(lock.fencingToken) ~= ARGV[2] then return {'TOKEN_STALE', tostring(lock.fencingToken)} end
local ttl = tonumber(ARGV[3])
local nowMs = tonumber(ARGV[4])
lock.expiresAtMs = nowMs + ttl * 1000
lock.lastRenewedAtMs = nowMs
redis.call('ZADD', KEYS[2], lock.expiresAtMs, ARGV[1])
redis.call('SET', KEYS[1], cjson.encode(lock), 'EX', ttl)
return {'RENEWED', cjson.encode(lock)}
`;

/**
 * SEAT release/confirm/expire — idempotent cleanup + short-lived tombstone. Only seat
 * keys still owned by this lock are removed (never steals another owner's seat).
 * KEYS: [lockKey, seatKey_1 … seatKey_N]   ARGV: [lockId, finalStatus, tombstoneTtl]
 */
export const SEAT_RELEASE = `
local raw = redis.call('GET', KEYS[1])
for i = 2, #KEYS do
  if redis.call('GET', KEYS[i]) == ARGV[1] then redis.call('DEL', KEYS[i]) end
end
if raw then
  local ok, lock = pcall(cjson.decode, raw)
  if ok then
    lock.status = ARGV[2]
    redis.call('SET', KEYS[1], cjson.encode(lock), 'EX', tonumber(ARGV[3]))
  end
end
return {ARGV[2], ''}
`;

/**
 * QUANTITY release/confirm/expire — removes the ZSET/HASH slot (held sum can never go
 * negative because it is a sum of remaining members) + short-lived tombstone.
 * KEYS: [lockKey, qtyZset, qtyHash]   ARGV: [lockId, finalStatus, tombstoneTtl]
 */
export const QUANTITY_RELEASE = `
local raw = redis.call('GET', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('HDEL', KEYS[3], ARGV[1])
if raw then
  local ok, lock = pcall(cjson.decode, raw)
  if ok then
    lock.status = ARGV[2]
    redis.call('SET', KEYS[1], cjson.encode(lock), 'EX', tonumber(ARGV[3]))
  end
end
return {ARGV[2], ''}
`;
