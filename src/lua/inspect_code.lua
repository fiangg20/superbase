-- Superbase snippet: look inside running code (upvalues, constants, the garbage collector, signal connections).
-- The MCP server puts "local args = ..." in front of this file. Everything here only reads.
-- Arguments:
--   args.action          "upvalues", "constants", "gc" or "connections"
--   upvalues, constants: args.path (a Script, LocalScript or ModuleScript), args.function_name (ModuleScript only: look at
--                        that function of the module instead of the main chunk), args.limit (default 40)
--   gc:                  args.kind ("function" default, or "table"), at least one filter: args.name_contains (function name),
--                        args.has_key (tables: a string key), args.has_constant (functions: a string constant),
--                        args.limit (default 25)
--   connections:         args.path (instance), args.signal (event name, e.g. "MouseButton1Click"), args.limit (default 25)

local action = tostring(args.action or "")
local limit = math.max(1, math.min(100, math.floor(tonumber(args.limit) or (action == "upvalues" and 40 or 25))))

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

-- Renders any value as a short string, so the result stays small and safe to send as JSON.
local function render(value, depth)
    depth = depth or 0
    local kind = typeof(value)
    if kind == "string" then
        if #value > 120 then
            return string.format("%q", string.sub(value, 1, 120)) .. "..."
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
            if count > 8 then
                parts[#parts + 1] = "..."
                break
            end
            parts[#parts + 1] = "[" .. render(key, depth + 1) .. "]=" .. render(item, depth + 1)
        end
        return "{" .. table.concat(parts, ", ") .. "}"
    elseif kind == "function" then
        return "<function>"
    end
    local ok, text = pcall(tostring, value)
    return kind .. "(" .. (ok and text or "?") .. ")"
end

-- Name, line and source of a function, whichever debug library the executor has.
local function functionInfo(fn)
    local info = {}
    if type(debug) == "table" and type(debug.info) == "function" then
        local ok, source, line, name = pcall(debug.info, fn, "sln")
        if ok then
            info.source, info.line, info.name = source, line, name
        end
    elseif type(debug) == "table" and type(debug.getinfo) == "function" then
        local ok, data = pcall(debug.getinfo, fn, "nS")
        if ok and type(data) == "table" then
            info.source, info.line, info.name = data.short_src or data.source, data.linedefined, data.name
        end
    end
    if info.name == "" then
        info.name = nil
    end
    -- The script that owns the function.
    if type(getfenv) == "function" then
        local ok, env = pcall(getfenv, fn)
        if ok and type(env) == "table" then
            local okScript, owner = pcall(function()
                return env.script
            end)
            if okScript and typeof(owner) == "Instance" then
                local okName, fullName = pcall(function()
                    return owner:GetFullName()
                end)
                info.script = okName and fullName or nil
            end
        end
    end
    return info
end

local function sortedIndexes(map)
    local indexes = {}
    for index in pairs(map) do
        indexes[#indexes + 1] = index
    end
    table.sort(indexes, function(a, b)
        if type(a) == "number" and type(b) == "number" then
            return a < b
        end
        return tostring(a) < tostring(b)
    end)
    return indexes
end

-- The function to inspect for upvalues and constants.
local function targetFunction()
    local path = tostring(args.path or "")
    if path == "" then
        return nil, "'path' is empty. Give the script to inspect."
    end
    local instance, missing = resolvePath(path)
    if not instance then
        return nil, "Not found at segment: " .. tostring(missing)
    end
    if not instance:IsA("LuaSourceContainer") then
        return nil, instance:GetFullName() .. " is a " .. instance.ClassName .. ", not a script."
    end

    if args.function_name then
        if not instance:IsA("ModuleScript") then
            return nil, "function_name only works for a ModuleScript."
        end
        local ok, exported = pcall(require, instance)
        if not ok then
            return nil, "Could not require the module: " .. tostring(exported)
        end
        local member = type(exported) == "table" and exported[tostring(args.function_name)] or nil
        if type(member) ~= "function" then
            return nil, "The module has no function named " .. tostring(args.function_name) .. "."
        end
        return member, nil, instance:GetFullName() .. "." .. tostring(args.function_name)
    end

    if type(getscriptclosure) ~= "function" then
        return nil, "This executor has no getscriptclosure. For a ModuleScript, pass function_name."
    end
    local ok, closure = pcall(getscriptclosure, instance)
    if not ok or type(closure) ~= "function" then
        return nil, "Could not get the closure of the script: " .. tostring(closure)
    end
    return closure, nil, instance:GetFullName()
end

if action == "upvalues" or action == "constants" then
    local fn, problem, label = targetFunction()
    if not fn then
        return { error = problem }
    end

    local reader
    if action == "upvalues" then
        reader = getupvalues or (type(debug) == "table" and debug.getupvalues) or nil
    else
        reader = getconstants or (type(debug) == "table" and debug.getconstants) or nil
    end
    if type(reader) ~= "function" then
        return { error = "This executor has no " .. (action == "upvalues" and "getupvalues" or "getconstants") .. "." }
    end

    local ok, values = pcall(reader, fn)
    if not ok or type(values) ~= "table" then
        return { error = "Could not read the " .. action .. ": " .. tostring(values) }
    end

    local list = {}
    local total = 0
    for _, index in ipairs(sortedIndexes(values)) do
        total = total + 1
        if #list < limit then
            local value = values[index]
            list[#list + 1] = { index = index, type = typeof(value), value = render(value) }
        end
    end
    return { target = label, action = action, total = total, returned = #list, truncated = total > #list, values = list }
elseif action == "gc" then
    if type(getgc) ~= "function" then
        return { error = "This executor has no getgc." }
    end
    local kind = args.kind == "table" and "table" or "function"
    local nameContains = args.name_contains and string.lower(tostring(args.name_contains)) or nil
    local hasKey = args.has_key and tostring(args.has_key) or nil
    local hasConstant = args.has_constant and tostring(args.has_constant) or nil
    if not (nameContains or hasKey or hasConstant) then
        return { error = "gc needs a filter: name_contains, has_key or has_constant. Without one it would return the whole heap." }
    end
    if kind == "table" and not hasKey then
        return { error = "For kind table use has_key." }
    end
    if kind == "function" and hasKey then
        return { error = "has_key is for kind table. For functions use name_contains or has_constant." }
    end

    local ok, everything = pcall(getgc, true)
    if not ok or type(everything) ~= "table" then
        return { error = "getgc failed: " .. tostring(everything) }
    end

    local results = {}
    local matched, scanned = 0, 0
    local constantReader = getconstants or (type(debug) == "table" and debug.getconstants) or nil
    for _, item in ipairs(everything) do
        scanned = scanned + 1
        if scanned % 5000 == 0 then
            task.wait()
        end
        if type(item) == kind then
            local keep = false
            if kind == "table" then
                local found = pcall(function()
                    keep = rawget(item, hasKey) ~= nil
                end)
                keep = found and keep
            else
                -- Functions of Superbase itself and of the executor are not interesting.
                local own = type(isexecutorclosure) == "function" and select(2, pcall(isexecutorclosure, item)) == true
                if not own then
                    keep = true
                    local info = functionInfo(item)
                    if nameContains then
                        keep = info.name ~= nil and string.find(string.lower(tostring(info.name)), nameContains, 1, true) ~= nil
                    end
                    if keep and hasConstant then
                        local found = false
                        if type(constantReader) == "function" then
                            local okConstants, constants = pcall(constantReader, item)
                            if okConstants and type(constants) == "table" then
                                for _, value in pairs(constants) do
                                    if value == hasConstant then
                                        found = true
                                        break
                                    end
                                end
                            end
                        end
                        keep = found
                    end
                    if keep then
                        item = { fn = item, info = info }
                    end
                end
            end

            if keep then
                matched = matched + 1
                if #results < limit then
                    if kind == "table" then
                        local keys = {}
                        for key, value in pairs(item) do
                            keys[#keys + 1] = render(key) .. ": " .. typeof(value)
                            if #keys >= 12 then
                                break
                            end
                        end
                        results[#results + 1] = { keys = keys, value = render(item) }
                    else
                        results[#results + 1] = {
                            name = item.info.name,
                            line = item.info.line,
                            source = item.info.source,
                            script = item.info.script,
                        }
                    end
                end
            end
        end
    end
    return { action = "gc", kind = kind, scanned = scanned, matched = matched, returned = #results, truncated = matched > #results, results = results }
elseif action == "connections" then
    if type(getconnections) ~= "function" then
        return { error = "This executor has no getconnections." }
    end
    local path = tostring(args.path or "")
    local signalName = tostring(args.signal or "")
    if path == "" or signalName == "" then
        return { error = "connections needs 'path' (the instance) and 'signal' (the event name, for example MouseButton1Click)." }
    end
    local instance, missing = resolvePath(path)
    if not instance then
        return { error = "Not found at segment: " .. tostring(missing) }
    end
    local okSignal, signal = pcall(function()
        return instance[signalName]
    end)
    if not okSignal or signal == nil then
        return { error = instance.ClassName .. " has no signal named " .. signalName .. "." }
    end
    local ok, list = pcall(getconnections, signal)
    if not ok or type(list) ~= "table" then
        return { error = "getconnections failed: " .. tostring(list) }
    end

    local results = {}
    for index, connection in ipairs(list) do
        if index > limit then
            break
        end
        local entry = {}
        pcall(function()
            entry.enabled = connection.Enabled
        end)
        pcall(function()
            entry.foreignState = connection.ForeignState
        end)
        local okFn, fn = pcall(function()
            return connection.Function
        end)
        if okFn and type(fn) == "function" then
            entry["function"] = functionInfo(fn)
        end
        results[#results + 1] = entry
    end
    return { action = "connections", target = instance:GetFullName(), signal = signalName, total = #list, returned = #results, connections = results }
end

return { error = "Unknown action '" .. action .. "'. Use upvalues, constants, gc or connections." }
