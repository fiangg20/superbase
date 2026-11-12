-- Recipe: Executor functions
-- Description: Dumps what getgenv() holds: the names and types of the executor functions, tables and other globals. Strings are never shown, only their length, because scripts often keep keys and tokens there. Superbase's own entries are left out.
-- Args: contains (string, optional, filter on the name), type (string, optional: function, table, string, number, boolean, userdata, thread), members (boolean, default true, also list the names inside tables), limit (number, default 500)

if type(getgenv) ~= "function" then
    return { error = "This executor has no getgenv." }
end
local okEnv, environment = pcall(getgenv)
if not okEnv or type(environment) ~= "table" then
    return { error = "getgenv() did not return a table." }
end

local contains = type(args.contains) == "string" and string.lower(args.contains) or nil
local wanted = type(args.type) == "string" and string.lower(args.type) or nil
local withMembers = args.members ~= false
local limit = tonumber(args.limit) or 500

local executor, version = nil, nil
if type(identifyexecutor) == "function" then
    local ok, name, build = pcall(identifyexecutor)
    if ok then
        executor, version = name, build
    end
end

local entries = {}
local counts = {}
local skipped = 0
for key, value in pairs(environment) do
    if type(key) ~= "string" then
        skipped = skipped + 1
    elseif string.sub(key, 1, 11) ~= "__Superbase" then
        local kind = type(value)
        if (not contains or string.find(string.lower(key), contains, 1, true)) and (not wanted or wanted == kind) then
            entries[#entries + 1] = { name = key, kind = kind, value = value }
            counts[kind] = (counts[kind] or 0) + 1
        end
    end
end
table.sort(entries, function(a, b)
    return a.name < b.name
end)

local functions, tables, values = {}, {}, {}
for index = 1, math.min(#entries, limit) do
    local entry = entries[index]
    if entry.kind == "function" then
        functions[#functions + 1] = entry.name
    elseif entry.kind == "table" then
        local item = { name = entry.name }
        local names = {}
        local ok = pcall(function()
            for memberKey in pairs(entry.value) do
                names[#names + 1] = tostring(memberKey)
            end
        end)
        table.sort(names)
        item.entries = ok and #names or nil
        if withMembers and ok then
            local shown = {}
            for position = 1, math.min(#names, 100) do
                shown[position] = names[position]
            end
            item.members = shown
            if #names > 100 then
                item.moreMembers = #names - 100
            end
        end
        tables[#tables + 1] = item
    else
        local item = { name = entry.name, type = entry.kind }
        if entry.kind == "boolean" or entry.kind == "number" then
            item.value = entry.value
        elseif entry.kind == "string" then
            item.length = #entry.value
        end
        values[#values + 1] = item
    end
end

return {
    executor = executor,
    version = version,
    total = #entries,
    returned = math.min(#entries, limit),
    counts = counts,
    nonStringKeys = skipped > 0 and skipped or nil,
    functions = functions,
    tables = tables,
    values = values,
}
