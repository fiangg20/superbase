-- Superbase snippet: search inside the source code of the game's scripts.
-- The MCP server puts "local args = ..." in front of this file.
-- Arguments:
--   args.query            text to look for
--   args.mode             "text" (exact substring, default), "pattern" (Lua pattern) or
--                         "words" (every word must appear, scripts are ranked by how often)
--   args.case_sensitive   default false
--   args.root             dotted path to search under, default game
--   args.class_name       "Script", "LocalScript" or "ModuleScript", default all
--   args.include_hidden   also search nil parented instances and loaded modules
--   args.max_scripts      how many scripts to decompile at most (default 150)
--   args.max_matches      how many matching lines (or scripts in words mode) to return (default 40)
--   args.context_lines    lines of context around a matching line (0 to 3)
--   args.budget_seconds   stop searching after this many seconds (default 20)

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

local query = tostring(args.query or "")
if query == "" then
    return { error = "The query is empty." }
end

local root, missing = resolvePath(tostring(args.root or "game"))
if not root then
    return { error = "Not found at segment: " .. tostring(missing) }
end

local mode = tostring(args.mode or "text")
if mode ~= "text" and mode ~= "pattern" and mode ~= "words" then
    return { error = "Unknown mode '" .. mode .. "'. Use text, pattern or words." }
end

-- Lua patterns cannot be matched case insensitively (lowering a pattern would change classes such
-- as %S), so the pattern mode is always case sensitive.
local caseSensitive = args.case_sensitive == true or mode == "pattern"
local classFilter = args.class_name and tostring(args.class_name) or nil
local includeHidden = args.include_hidden == true
local maxScripts = math.max(1, math.min(500, math.floor(tonumber(args.max_scripts) or 150)))
local maxMatches = math.max(1, math.min(200, math.floor(tonumber(args.max_matches) or 40)))
local contextLines = math.max(0, math.min(3, math.floor(tonumber(args.context_lines) or 0)))
local budget = math.max(2, math.min(100, tonumber(args.budget_seconds) or 20))

local needle = caseSensitive and query or string.lower(query)
local words = {}
if mode == "words" then
    for word in string.gmatch(needle, "%S+") do
        words[#words + 1] = word
    end
    if #words == 0 then
        return { error = "The query has no words." }
    end
end

if mode == "pattern" then
    local ok, err = pcall(string.find, "", needle)
    if not ok then
        return { error = "Invalid Lua pattern: " .. tostring(err) }
    end
end

-- Collect the scripts to search.
local scripts = {}
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
    scripts[#scripts + 1] = instance
end

local scanned = 0
for _, instance in ipairs(root:GetDescendants()) do
    scanned = scanned + 1
    if scanned % 5000 == 0 then
        task.wait()
    end
    consider(instance)
end

local function considerAll(getter)
    local ok, list = pcall(getter)
    if ok and type(list) == "table" then
        for _, instance in ipairs(list) do
            consider(instance)
        end
    end
end

if includeHidden then
    if type(getnilinstances) == "function" then
        considerAll(getnilinstances)
    end
    if type(getloadedmodules) == "function" then
        considerAll(getloadedmodules)
    end
    if type(getscripts) == "function" then
        considerAll(getscripts)
    end
end

-- Some executors decompile through an online service. When it is down they return an error page
-- instead of source code, so recognize that output.
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

local function splitLines(source)
    local lines = {}
    for line in string.gmatch(source .. "\n", "(.-)\r?\n") do
        lines[#lines + 1] = line
    end
    return lines
end

local function cut(text)
    if #text > 200 then
        return string.sub(text, 1, 200) .. "..."
    end
    return text
end

local function countPlain(haystack, word)
    local total, position = 0, 1
    while true do
        local from, to = string.find(haystack, word, position, true)
        if not from then
            return total
        end
        total = total + 1
        position = to + 1
    end
end

local started = os.clock()
local searched = 0
local unreadable = 0
local timedOut = false
local truncated = #scripts > maxScripts
local matches = {}
local totalMatches = 0

for index, instance in ipairs(scripts) do
    if index > maxScripts then
        break
    end
    if os.clock() - started > budget then
        timedOut = true
        break
    end

    local source = readSource(instance)
    if not source then
        unreadable = unreadable + 1
    else
        searched = searched + 1
        local haystack = caseSensitive and source or string.lower(source)

        if mode == "words" then
            local score = 0
            local allFound = true
            for _, word in ipairs(words) do
                local occurrences = countPlain(haystack, word)
                if occurrences == 0 then
                    allFound = false
                    break
                end
                score = score + occurrences
            end

            if allFound then
                totalMatches = totalMatches + 1
                local lines = splitLines(source)
                local lowered = splitLines(haystack)
                local samples = {}
                for number, text in ipairs(lowered) do
                    for _, word in ipairs(words) do
                        if string.find(text, word, 1, true) then
                            samples[#samples + 1] = { line = number, text = cut(lines[number]) }
                            break
                        end
                    end
                    if #samples >= 3 then
                        break
                    end
                end
                matches[#matches + 1] = {
                    path = instance:GetFullName(),
                    className = instance.ClassName,
                    score = score,
                    lines = samples,
                }
            end
        else
            local hasMatch
            if mode == "pattern" then
                local ok, found = pcall(string.find, haystack, needle)
                hasMatch = ok and found ~= nil
            else
                hasMatch = string.find(haystack, needle, 1, true) ~= nil
            end

            if hasMatch then
                local lines = splitLines(source)
                local lowered = caseSensitive and lines or splitLines(haystack)
                for number, text in ipairs(lowered) do
                    local found
                    if mode == "pattern" then
                        local ok, result = pcall(string.find, text, needle)
                        found = ok and result ~= nil
                    else
                        found = string.find(text, needle, 1, true) ~= nil
                    end

                    if found then
                        totalMatches = totalMatches + 1
                        if #matches < maxMatches then
                            local entry = {
                                path = instance:GetFullName(),
                                className = instance.ClassName,
                                line = number,
                                text = cut(lines[number]),
                            }
                            if contextLines > 0 then
                                local before, after = {}, {}
                                for offset = contextLines, 1, -1 do
                                    if lines[number - offset] then
                                        before[#before + 1] = cut(lines[number - offset])
                                    end
                                end
                                for offset = 1, contextLines do
                                    if lines[number + offset] then
                                        after[#after + 1] = cut(lines[number + offset])
                                    end
                                end
                                entry.before = before
                                entry.after = after
                            end
                            matches[#matches + 1] = entry
                        end
                    end
                end
            end
        end
    end

    if index % 10 == 0 then
        task.wait()
    end
end

if mode == "words" then
    table.sort(matches, function(a, b)
        return a.score > b.score
    end)
    while #matches > maxMatches do
        table.remove(matches)
    end
end

return {
    query = query,
    mode = mode,
    candidates = #scripts,
    searched = searched,
    unreadable = unreadable,
    timedOut = timedOut,
    truncatedScripts = truncated,
    totalMatches = totalMatches,
    returned = #matches,
    elapsedSeconds = math.floor((os.clock() - started) * 10) / 10,
    matches = matches,
}
