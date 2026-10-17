-- Superbase snippet: read the source of a script.
-- The MCP server puts "local args = ..." in front of this file.
-- Arguments: args.path (dotted path to a Script, LocalScript or ModuleScript), args.max_chars.

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

if type(decompile) == "function" then
    local ok, result = pcall(decompile, instance)
    if ok and type(result) == "string" and #result > 0 then
        source = result
        method = "decompile"
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
    length = length,
    truncated = truncated,
    source = source,
}
