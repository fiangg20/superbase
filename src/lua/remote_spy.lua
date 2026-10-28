-- Superbase snippet: record calls to RemoteEvent:FireServer and RemoteFunction:InvokeServer.
-- The MCP server puts "local args = ..." in front of this file.
-- Arguments:
--   args.action        "start", "stop", "get", "clear" or "status"
--   start:  args.ignore (remote names to skip), args.only (remote name substring to keep),
--           args.max_calls (buffer size, default 500), args.include_own (also record calls made by
--           code run through Superbase, default false)
--   get:    args.since_id (only calls after this id), args.contains (text in the remote name or the
--           arguments), args.remote (exact remote name), args.limit (default 50)
-- The recorder lives in the executor's global table, so it survives running this snippet again.

local action = tostring(args.action or "status")
local genv = (getgenv and getgenv()) or _G

local state = genv.__SuperbaseSpy
if type(state) ~= "table" then
    state = {
        active = false,
        hooked = false,
        calls = {},
        nextId = 1,
        dropped = 0,
        maxCalls = 500,
        ignore = {},
        only = nil,
        includeOwn = false,
    }
    genv.__SuperbaseSpy = state
end

local function statusInfo()
    return {
        active = state.active,
        hooked = state.hooked,
        buffered = #state.calls,
        lastId = state.nextId - 1,
        dropped = state.dropped,
        maxCalls = state.maxCalls,
        only = state.only,
        includeOwn = state.includeOwn,
    }
end

-- Renders any value as a short string, so the result stays small and safe to send as JSON.
local function render(value, depth)
    depth = depth or 0
    local kind = typeof(value)

    if kind == "string" then
        if #value > 200 then
            return string.format("%q", string.sub(value, 1, 200)) .. "..."
        end
        return string.format("%q", value)
    elseif kind == "number" or kind == "boolean" or kind == "nil" then
        return tostring(value)
    elseif kind == "Instance" then
        local ok, name = pcall(function()
            return value:GetFullName()
        end)
        return "Instance<" .. value.ClassName .. ">(" .. (ok and name or "?") .. ")"
    elseif kind == "EnumItem" then
        return tostring(value)
    elseif kind == "table" then
        if depth >= 3 then
            return "{...}"
        end
        local parts = {}
        local count = 0
        for key, item in pairs(value) do
            count = count + 1
            if count > 15 then
                parts[#parts + 1] = "..."
                break
            end
            if type(key) == "number" and key == count then
                parts[#parts + 1] = render(item, depth + 1)
            else
                parts[#parts + 1] = "[" .. render(key, depth + 1) .. "]=" .. render(item, depth + 1)
            end
        end
        return "{" .. table.concat(parts, ", ") .. "}"
    elseif kind == "function" then
        return "<function>"
    end
    local ok, text = pcall(tostring, value)
    return kind .. "(" .. (ok and text or "?") .. ")"
end

local function isRemote(instance)
    if typeof(instance) ~= "Instance" then
        return false
    end
    local ok, result = pcall(function()
        return instance:IsA("RemoteEvent") or instance:IsA("RemoteFunction") or instance.ClassName == "UnreliableRemoteEvent"
    end)
    return ok and result
end

local function record(remote, method, packed)
    local name = remote.Name
    if state.ignore[name] then
        return
    end
    if state.only and not string.find(string.lower(name), state.only, 1, true) then
        return
    end
    if not state.includeOwn and type(checkcaller) == "function" and checkcaller() then
        return
    end

    local rendered = {}
    for index = 1, math.min(packed.n, 12) do
        rendered[index] = render(packed[index])
    end

    local caller = nil
    if type(getcallingscript) == "function" then
        local ok, script = pcall(getcallingscript)
        if ok and typeof(script) == "Instance" then
            local okName, fullName = pcall(function()
                return script:GetFullName()
            end)
            caller = okName and fullName or nil
        end
    end

    local id = state.nextId
    state.nextId = id + 1
    state.calls[#state.calls + 1] = {
        id = id,
        time = os.time() * 1000,
        remote = remote:GetFullName(),
        name = name,
        className = remote.ClassName,
        method = method,
        argCount = packed.n,
        args = rendered,
        caller = caller,
    }

    while #state.calls > state.maxCalls do
        table.remove(state.calls, 1)
        state.dropped = state.dropped + 1
    end
end

local function install()
    if state.hooked then
        return true
    end
    if type(hookmetamethod) ~= "function" or type(getnamecallmethod) ~= "function" then
        return false, "This executor does not provide hookmetamethod and getnamecallmethod, which the remote spy needs."
    end

    local original
    local handler = function(self, ...)
        local method = getnamecallmethod()
        if method == "FireServer" or method == "InvokeServer" then
            if state.active and isRemote(self) then
                pcall(record, self, method, table.pack(...))
            end
            -- Calling other functions can reset the namecall method on some executors.
            if type(setnamecallmethod) == "function" then
                setnamecallmethod(method)
            end
        end
        return original(self, ...)
    end

    if type(newcclosure) == "function" then
        handler = newcclosure(handler)
    end

    local ok, result = pcall(hookmetamethod, game, "__namecall", handler)
    if not ok then
        return false, "Could not hook __namecall: " .. tostring(result)
    end
    original = result
    state.hooked = true
    return true
end

if action == "start" then
    local installed, reason = install()
    if not installed then
        return { error = reason }
    end

    state.ignore = {}
    if type(args.ignore) == "table" then
        for _, name in ipairs(args.ignore) do
            state.ignore[tostring(name)] = true
        end
    end
    state.only = args.only and string.lower(tostring(args.only)) or nil
    state.includeOwn = args.include_own == true
    state.maxCalls = math.max(50, math.min(2000, math.floor(tonumber(args.max_calls) or 500)))
    state.active = true
    return statusInfo()
elseif action == "stop" then
    state.active = false
    return statusInfo()
elseif action == "clear" then
    state.calls = {}
    state.dropped = 0
    return statusInfo()
elseif action == "status" then
    return statusInfo()
elseif action == "get" then
    local sinceId = tonumber(args.since_id) or 0
    local limit = math.max(1, math.min(200, math.floor(tonumber(args.limit) or 50)))
    local contains = args.contains and string.lower(tostring(args.contains)) or nil
    local exact = args.remote and tostring(args.remote) or nil

    local matches = {}
    for _, call in ipairs(state.calls) do
        if call.id > sinceId and (not exact or call.name == exact) then
            local keep = true
            if contains then
                local text = string.lower(call.name .. " " .. table.concat(call.args, " "))
                keep = string.find(text, contains, 1, true) ~= nil
            end
            if keep then
                matches[#matches + 1] = call
            end
        end
    end

    -- Keep the newest calls when there are more than the limit.
    local calls = {}
    for index = math.max(1, #matches - limit + 1), #matches do
        calls[#calls + 1] = matches[index]
    end

    local info = statusInfo()
    info.matched = #matches
    info.returned = #calls
    info.calls = calls
    return info
end

return { error = "Unknown action '" .. action .. "'. Use start, stop, get, clear or status." }
