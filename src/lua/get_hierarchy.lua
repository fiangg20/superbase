-- Superbase snippet: print the instance tree as an indented outline.
-- The MCP server puts "local args = ..." in front of this file.
-- Arguments: args.root (dotted path, default game), args.depth (1 to 8), args.max_nodes,
-- args.max_children (per node) and args.class_name (only list matching nodes and their ancestors).

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

local maxDepth = math.max(1, math.min(8, math.floor(tonumber(args.depth) or 3)))
local maxNodes = math.max(10, math.min(1000, math.floor(tonumber(args.max_nodes) or 300)))
local maxChildren = math.max(1, math.min(200, math.floor(tonumber(args.max_children) or 40)))
local classFilter = args.class_name and tostring(args.class_name) or nil

local lines = {}
local nodes = 0
local truncated = false

local function isClass(instance, className)
    local ok, result = pcall(function()
        return instance:IsA(className)
    end)
    return ok and result
end

-- With a class filter, a branch is only shown when something in it matches.
local function branchMatches(instance, remainingDepth)
    if isClass(instance, classFilter) then
        return true
    end
    if remainingDepth <= 0 then
        return false
    end
    for _, child in ipairs(instance:GetChildren()) do
        if branchMatches(child, remainingDepth - 1) then
            return true
        end
    end
    return false
end

local function label(instance)
    if instance.Name == instance.ClassName then
        return instance.Name
    end
    return instance.Name .. " [" .. instance.ClassName .. "]"
end

local function walk(instance, depth)
    if nodes >= maxNodes then
        truncated = true
        return
    end
    nodes = nodes + 1
    lines[#lines + 1] = string.rep("  ", depth) .. label(instance)

    if depth >= maxDepth then
        local count = #instance:GetChildren()
        if count > 0 then
            lines[#lines + 1] = string.rep("  ", depth + 1) .. "... " .. count .. " more, deeper than depth " .. maxDepth
        end
        return
    end

    local children = instance:GetChildren()
    local shown = 0
    local skipped = 0
    for _, child in ipairs(children) do
        if nodes >= maxNodes then
            truncated = true
            break
        end
        if not classFilter or branchMatches(child, maxDepth - depth - 1) then
            if shown >= maxChildren then
                skipped = skipped + 1
            else
                shown = shown + 1
                walk(child, depth + 1)
            end
        end
    end

    if skipped > 0 then
        lines[#lines + 1] = string.rep("  ", depth + 1) .. "... " .. skipped .. " more children not shown"
    end
end

walk(root, 0)

if truncated then
    lines[#lines + 1] = "... stopped at " .. maxNodes .. " nodes, narrow the root or lower the depth"
end

return {
    root = root:GetFullName(),
    depth = maxDepth,
    nodes = nodes,
    truncated = truncated,
    tree = table.concat(lines, "\n"),
}
