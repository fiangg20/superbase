-- Superbase snippet: dump the source code of the game's scripts, one page at a time (for the semantic index).
-- The MCP server puts "local args = ..." in front of this file.
-- Arguments:
--   args.offset            index of the first script of this page (default 0)
--   args.page_chars        stop the page after about this much source text (default 40000)
--   args.max_script_chars  cut a single script after this many characters (default 20000)
--   args.root              dotted path to dump under, default game
--   args.class_name        "Script", "LocalScript" or "ModuleScript", default all
--   args.include_hidden    also dump nil parented instances and loaded modules
--   args.budget_seconds    stop the page after this many seconds (default 15)
-- Scripts are sorted by path, so the same offset means the same script in the next call.
-- Returns placeId, total, offset, nextOffset (nil on the last page), scripts { path, className, source, truncated }
-- and unreadable (scripts that could not be decompiled).

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

local offset = math.max(0, math.floor(tonumber(args.offset) or 0))
local pageChars = math.max(5000, math.min(50000, math.floor(tonumber(args.page_chars) or 40000)))
local maxScriptChars = math.max(500, math.min(50000, math.floor(tonumber(args.max_script_chars) or 20000)))
local budget = math.max(2, math.min(60, tonumber(args.budget_seconds) or 15))
local classFilter = args.class_name and tostring(args.class_name) or nil
local includeHidden = args.include_hidden == true

local entries = {}
local seen = {}

local function consider(instance)
    if seen[instance] then
        return
    end
    local ok, isScript = pcall(function()
        return instance:IsA("LuaSourceContainer")
    end)
    if not (ok and isScript) then
        return
    end
    if classFilter then
        local matches = pcall(function()
            assert(instance:IsA(classFilter))
        end)
        if not matches then
            return
        end
    end
    seen[instance] = true
    local named, fullName = pcall(function()
        return instance:GetFullName()
    end)
    entries[#entries + 1] = { instance = instance, path = named and fullName or tostring(instance) }
end

local scanned = 0
for _, instance in ipairs(root:GetDescendants()) do
    scanned = scanned + 1
    if scanned % 5000 == 0 then
        task.wait()
    end
    consider(instance)
end

if includeHidden then
    for _, getter in ipairs({ getnilinstances, getloadedmodules, getscripts }) do
        if type(getter) == "function" then
            local ok, list = pcall(getter)
            if ok and type(list) == "table" then
                for _, instance in ipairs(list) do
                    consider(instance)
                end
            end
        end
    end
end

table.sort(entries, function(a, b)
    return a.path < b.path
end)

-- Some executors decompile through an online service. When it is down they return an error page.
local function looksLikeDecompilerError(text)
    local head = string.lower(string.sub(text, 1, 200))
    return string.find(head, "api request error", 1, true) ~= nil
        or string.find(head, "decompil", 1, true) ~= nil and string.find(head, "fail", 1, true) ~= nil
        or string.find(head, "<!doctype html", 1, true) ~= nil
end

local function readSource(instance)
    if type(decompile) == "function" then
        local ok, result = pcall(decompile, instance)
        if ok and type(result) == "string" and #result > 0 and not looksLikeDecompilerError(result) then
            return result
        end
    end
    local ok, result = pcall(function()
        return instance.Source
    end)
    if ok and type(result) == "string" and #result > 0 then
        return result
    end
    return nil
end

local started = os.clock()
local pageSize = 0
local unreadable = 0
local scripts = {}
local index = offset + 1
local total = #entries

while index <= total do
    if #scripts > 0 and (pageSize >= pageChars or os.clock() - started > budget) then
        break
    end
    local entry = entries[index]
    local source = readSource(entry.instance)
    if source then
        local truncated = false
        if #source > maxScriptChars then
            source = string.sub(source, 1, maxScriptChars)
            truncated = true
        end
        local className = "LuaSourceContainer"
        pcall(function()
            className = entry.instance.ClassName
        end)
        scripts[#scripts + 1] = { path = entry.path, className = className, source = source, truncated = truncated or nil }
        pageSize = pageSize + #source
    else
        unreadable = unreadable + 1
    end
    index = index + 1
end

return {
    placeId = game.PlaceId,
    total = total,
    offset = offset,
    nextOffset = index <= total and (index - 1) or nil,
    scripts = scripts,
    unreadable = unreadable,
}
