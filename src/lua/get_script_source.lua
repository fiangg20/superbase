-- Superbase snippet: read the source of a script.
-- The MCP server puts "local args = ..." in front of this file.
-- Arguments: args.path (dotted path to a Script, LocalScript or ModuleScript), args.max_chars, args.refresh
-- (decompile again instead of using the cached source).

local function resolvePath(path)
    local current = game
    local first = true
    for segment in string.gmatch(path, "[^%.]+") do
        if first and segment == "game" then
            first = false
        else
            first = false
            current = current:FindFirstChild(segment)
            if not current then
                return nil, segment
            end
        end
    end
    return current
end

local instance, missing = resolvePath(tostring(args.path))
if not instance then
    return { error = "Not found at segment: " .. tostring(missing) }
end

if not instance:IsA("LuaSourceContainer") then
    return { error = instance:GetFullName() .. " is a " .. instance.ClassName .. ", not a script." }
end

local source = nil
local method = nil

-- Some executors decompile through an online service. When that service is down, they return
-- an error page as if it were the source, so recognize that output and treat it as a failure.
local function looksLikeDecompilerError(text)
    local head = string.lower(string.sub(text, 1, 200))
    return string.find(head, "api request error", 1, true) ~= nil
        or string.find(head, "decompil", 1, true) ~= nil and string.find(head, "fail", 1, true) ~= nil
        or string.find(head, "<!doctype html", 1, true) ~= nil
end

-- Decompiling is slow, so the results are kept in the executor's global table. The keys are weak, so a script that
-- is destroyed disappears from the cache. args.refresh = true decompiles again.
local cacheOwner = (getgenv and getgenv()) or _G
local sourceCache = cacheOwner.__SuperbaseSources
if type(sourceCache) ~= "table" then
    sourceCache = setmetatable({}, { __mode = "k" })
    cacheOwner.__SuperbaseSources = sourceCache
end
local refreshCache = args.refresh == true
local cacheHits = 0

local decompileFailed = false
local fromCache = false

if not refreshCache and sourceCache[instance] then
    source = sourceCache[instance]
    method = "decompile"
    fromCache = true
elseif type(decompile) == "function" then
    local ok, result = pcall(decompile, instance)
    if ok and type(result) == "string" and #result > 0 then
        if looksLikeDecompilerError(result) then
            decompileFailed = true
        else
            source = result
            method = "decompile"
            sourceCache[instance] = result
        end
    end
end

if not source then
    local ok, result = pcall(function()
        return instance.Source
    end)
    if ok and type(result) == "string" and #result > 0 then
        source = result
        method = "Source"
    end
end

if not source then
    if decompileFailed then
        return { error = "The executor's decompiler returned an error instead of source code (its online service may be down). Try again later." }
    end
    return { error = "Could not read the source. This executor has no working decompile and the Source property is not readable." }
end

local maxChars = math.max(100, math.min(40000, tonumber(args.max_chars) or 20000))
local length = #source
local truncated = length > maxChars
if truncated then
    source = string.sub(source, 1, maxChars)
end

return {
    path = instance:GetFullName(),
    className = instance.ClassName,
    method = method,
    fromCache = fromCache,
    length = length,
    truncated = truncated,
    source = source,
}
