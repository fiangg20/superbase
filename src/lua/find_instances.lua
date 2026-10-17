-- Superbase snippet: search the instance tree.
-- The MCP server puts "local args = ..." in front of this file.
-- Arguments: args.root (dotted path, default game), args.name (substring),
-- args.class_name (class or base class) and args.limit.

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

local nameFilter = nil
if args.name then
    nameFilter = string.lower(tostring(args.name))
end

local classFilter = nil
if args.class_name then
    classFilter = tostring(args.class_name)
end

local limit = math.max(1, math.min(200, tonumber(args.limit) or 50))

local results = {}
local scanned = 0
local truncated = false

for _, instance in ipairs(root:GetDescendants()) do
    scanned = scanned + 1
    if scanned % 5000 == 0 then
        task.wait()
    end

    local matches = true

    if nameFilter and not string.find(string.lower(instance.Name), nameFilter, 1, true) then
        matches = false
    end

    if matches and classFilter then
        local ok, isClass = pcall(function()
            return instance:IsA(classFilter)
        end)
        if not (ok and isClass) then
            matches = false
        end
    end

    if matches then
        if #results >= limit then
            truncated = true
            break
        end
        results[#results + 1] = {
            path = instance:GetFullName(),
            className = instance.ClassName,
        }
    end
end

return {
    root = root:GetFullName(),
    scanned = scanned,
    count = #results,
    truncated = truncated,
    results = results,
}
