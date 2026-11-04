-- Superbase snippet: call a method on an instance, fire a remote, or fire a signal.
-- The MCP server puts "local args = ..." in front of this file. This changes the running game.
-- Arguments:
--   args.action   "method", "fire_remote" or "fire_signal"
--   args.path     dotted path of the instance
--   args.method   method, for "method" (for example "FindFirstChild", "Activate", "Destroy")
--   args.signal   signal name, for "fire_signal" (for example "MouseButton1Click")
--   args.args     list of arguments. A table with __type becomes a Roblox value:
--                 {__type="Vector3", x=, y=, z=}, {__type="Vector2", x=, y=}, {__type="Color3", r=, g=, b=} (0 to 255),
--                 {__type="CFrame", x=, y=, z=}, {__type="Enum", enum="Material", name="Neon"} (or value="Enum.Material.Neon"),
--                 {__type="Instance", path="game.Workspace.Part"}. Other tables stay tables (converted inside too).

local action = tostring(args.action or "")

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

local convert
convert = function(value)
    if type(value) ~= "table" then
        return value
    end

    local kind = value.__type
    if kind == nil then
        local copy = {}
        for key, item in pairs(value) do
            copy[key] = convert(item)
        end
        return copy
    end

    if kind == "Vector3" then
        return Vector3.new(value.x or 0, value.y or 0, value.z or 0)
    elseif kind == "Vector2" then
        return Vector2.new(value.x or 0, value.y or 0)
    elseif kind == "Color3" then
        return Color3.fromRGB(value.r or 0, value.g or 0, value.b or 0)
    elseif kind == "CFrame" then
        return CFrame.new(value.x or 0, value.y or 0, value.z or 0)
    elseif kind == "Enum" then
        if value.value then
            local enumName, itemName = string.match(tostring(value.value), "^Enum%.([%w_]+)%.([%w_]+)$")
            if not enumName then
                error("An Enum value must look like Enum.Material.Neon.")
            end
            return Enum[enumName][itemName]
        end
        return Enum[tostring(value.enum)][tostring(value.name)]
    elseif kind == "Instance" then
        local target, missing = resolvePath(tostring(value.path))
        if not target then
            error("Instance not found at segment: " .. tostring(missing))
        end
        return target
    end

    error("Unsupported value type: " .. tostring(kind))
end

-- Renders any value as a short string, so the result stays small and safe to send as JSON.
local function render(value, depth)
    depth = depth or 0
    local kind = typeof(value)
    if kind == "string" then
        if #value > 300 then
            return string.format("%q", string.sub(value, 1, 300)) .. "..."
        end
        return string.format("%q", value)
    elseif kind == "number" or kind == "boolean" or kind == "nil" then
        return tostring(value)
    elseif kind == "Instance" then
        local ok, name = pcall(function()
            return value:GetFullName()
        end)
        return "Instance<" .. value.ClassName .. ">(" .. (ok and name or "?") .. ")"
    elseif kind == "table" then
        if depth >= 2 then
            return "{...}"
        end
        local parts, count = {}, 0
        for key, item in pairs(value) do
            count = count + 1
            if count > 10 then
                parts[#parts + 1] = "..."
                break
            end
            parts[#parts + 1] = "[" .. render(key, depth + 1) .. "]=" .. render(item, depth + 1)
        end
        return "{" .. table.concat(parts, ", ") .. "}"
    end
    local ok, text = pcall(tostring, value)
    return kind .. "(" .. (ok and text or "?") .. ")"
end

if action ~= "method" and action ~= "fire_remote" and action ~= "fire_signal" then
    return { error = "Unknown action '" .. action .. "'. Use method, fire_remote or fire_signal." }
end

local path = tostring(args.path or "")
if path == "" then
    return { error = "'path' is empty." }
end
local instance, missing = resolvePath(path)
if not instance then
    return { error = "Not found at segment: " .. tostring(missing) }
end

local converted = {}
local count = 0
if type(args.args) == "table" then
    for index, item in ipairs(args.args) do
        local ok, value = pcall(convert, item)
        if not ok then
            return { error = "Argument " .. index .. ": " .. tostring(value) }
        end
        converted[index] = value
        count = index
    end
end

local function describe(results)
    local rendered = {}
    for index = 1, math.min(results.n, 10) do
        rendered[index] = render(results[index])
    end
    return rendered
end

if action == "method" then
    local name = tostring(args.method or "")
    if name == "" then
        return { error = "'method' is empty." }
    end
    local okMember, member = pcall(function()
        return instance[name]
    end)
    if not okMember or type(member) ~= "function" then
        return { error = instance.ClassName .. " has no method named " .. name .. "." }
    end
    local results = table.pack(pcall(member, instance, table.unpack(converted, 1, count)))
    if not results[1] then
        return { error = tostring(results[2]) }
    end
    local values = table.pack(table.unpack(results, 2, results.n))
    return { path = instance:GetFullName(), method = name, resultCount = values.n, results = describe(values) }
elseif action == "fire_remote" then
    local isEvent = instance:IsA("RemoteEvent") or instance.ClassName == "UnreliableRemoteEvent"
    local isFunction = instance:IsA("RemoteFunction")
    if not (isEvent or isFunction) then
        return { error = instance:GetFullName() .. " is a " .. instance.ClassName .. ", not a RemoteEvent or RemoteFunction." }
    end
    local callName = isEvent and "FireServer" or "InvokeServer"
    local results = table.pack(pcall(function()
        return instance[callName](instance, table.unpack(converted, 1, count))
    end))
    if not results[1] then
        return { error = tostring(results[2]) }
    end
    local values = table.pack(table.unpack(results, 2, results.n))
    return { path = instance:GetFullName(), call = callName, argCount = count, resultCount = values.n, results = describe(values) }
else
    if type(firesignal) ~= "function" then
        return { error = "This executor has no firesignal." }
    end
    local signalName = tostring(args.signal or "")
    if signalName == "" then
        return { error = "'signal' is empty." }
    end
    local okSignal, signal = pcall(function()
        return instance[signalName]
    end)
    if not okSignal or signal == nil then
        return { error = instance.ClassName .. " has no signal named " .. signalName .. "." }
    end
    local ok, failure = pcall(firesignal, signal, table.unpack(converted, 1, count))
    if not ok then
        return { error = tostring(failure) }
    end
    return { path = instance:GetFullName(), signal = signalName, argCount = count, fired = true }
end
