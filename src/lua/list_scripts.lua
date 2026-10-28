-- Superbase snippet: list the scripts the game has.
-- The MCP server puts "local args = ..." in front of this file.
-- Arguments: args.root (dotted path, default game), args.class_name ("Script", "LocalScript" or
-- "ModuleScript", default all), args.name (substring), args.include_hidden (also scripts that are not
-- in the tree: nil parented instances and loaded modules) and args.limit.

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

local root, missing = resolvePath(tostring(args.root or "game"))
if not root then
    return { error = "Not found at segment: " .. tostring(missing) }
end

local classFilter = args.class_name and tostring(args.class_name) or nil
local nameFilter = args.name and string.lower(tostring(args.name)) or nil
local includeHidden = args.include_hidden == true
local limit = math.max(1, math.min(500, math.floor(tonumber(args.limit) or 100)))

local results = {}
local seen = {}
local counts = { Script = 0, LocalScript = 0, ModuleScript = 0 }
local truncated = false
local scanned = 0

local function accepts(instance)
    if seen[instance] then
        return false
    end
    local ok, isScript = pcall(function()
        return instance:IsA("LuaSourceContainer")
    end)
    if not (ok and isScript) then
        return false
    end
    if classFilter then
        local matches = pcall(function()
            assert(instance:IsA(classFilter))
        end)
        if not matches then
            return false
        end
    end
    if nameFilter and not string.find(string.lower(instance.Name), nameFilter, 1, true) then
        return false
    end
    return true
end

local function add(instance, where)
    if not accepts(instance) then
        return
    end
    seen[instance] = true
    if counts[instance.ClassName] ~= nil then
        counts[instance.ClassName] = counts[instance.ClassName] + 1
    end
    if #results >= limit then
        truncated = true
        return
    end

    local entry = {
        path = instance:GetFullName(),
        className = instance.ClassName,
        where = where,
    }
    local okDisabled, disabled = pcall(function()
        return instance.Disabled
    end)
    if okDisabled and disabled == true then
        entry.disabled = true
    end
    results[#results + 1] = entry
end

for _, instance in ipairs(root:GetDescendants()) do
    scanned = scanned + 1
    if scanned % 5000 == 0 then
        task.wait()
    end
    add(instance, "tree")
end

local hiddenNote = nil
if includeHidden then
    local missingApis = {}

    if type(getnilinstances) == "function" then
        local ok, list = pcall(getnilinstances)
        if ok and type(list) == "table" then
            for _, instance in ipairs(list) do
                add(instance, "nil")
            end
        end
    else
        missingApis[#missingApis + 1] = "getnilinstances"
    end

    if type(getloadedmodules) == "function" then
        local ok, list = pcall(getloadedmodules)
        if ok and type(list) == "table" then
            for _, instance in ipairs(list) do
                add(instance, "loaded")
            end
        end
    else
        missingApis[#missingApis + 1] = "getloadedmodules"
    end

    if type(getscripts) == "function" then
        local ok, list = pcall(getscripts)
        if ok and type(list) == "table" then
            for _, instance in ipairs(list) do
                add(instance, "running")
            end
        end
    else
        missingApis[#missingApis + 1] = "getscripts"
    end

    if #missingApis > 0 then
        hiddenNote = "This executor does not provide: " .. table.concat(missingApis, ", ")
    end
end

return {
    root = root:GetFullName(),
    total = counts.Script + counts.LocalScript + counts.ModuleScript,
    counts = counts,
    count = #results,
    truncated = truncated,
    note = hiddenNote,
    scripts = results,
}
