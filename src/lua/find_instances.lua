-- Superbase snippet: search the instance tree.
-- The MCP server puts "local args = ..." in front of this file.
-- Arguments: args.root (dotted path, default game), args.name (substring), args.class_name (class or
-- base class), args.steps (parsed selector, see src/selector.js), args.properties (names of properties
-- to return for every match) and args.limit.

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
local steps = type(args.steps) == "table" and args.steps or nil
if steps and #steps == 0 then
    steps = nil
end

local wanted = {}
if type(args.properties) == "table" then
    for index, name in ipairs(args.properties) do
        if index > 8 then
            break
        end
        wanted[#wanted + 1] = tostring(name)
    end
end

local MAX_WORKING_SET = 50000
local scanned = 0

local function pace()
    scanned = scanned + 1
    if scanned % 5000 == 0 then
        task.wait()
    end
end

local function readProperty(instance, name)
    local ok, value = pcall(function()
        return instance[name]
    end)
    if ok then
        return true, value
    end
    local okAttribute, attribute = pcall(function()
        return instance:GetAttribute(name)
    end)
    if okAttribute and attribute ~= nil then
        return true, attribute
    end
    return false, nil
end

-- Enum items compare by name, instances by full name, everything else by its string form.
local function asText(value)
    local kind = typeof(value)
    if kind == "EnumItem" then
        return value.Name
    elseif kind == "Instance" then
        return value:GetFullName()
    end
    return tostring(value)
end

local function attributeMatches(instance, condition)
    local found, actual = readProperty(instance, condition.prop)
    if not found then
        return false
    end

    local op = condition.op
    if op == "truthy" then
        return actual ~= nil and actual ~= false and actual ~= 0 and actual ~= ""
    end

    local expected = condition.value
    local kind = type(expected)

    if kind == "boolean" then
        if op == "=" then
            return actual == expected
        elseif op == "!=" then
            return actual ~= expected
        end
        return false
    end

    if kind == "number" and type(actual) == "number" then
        if op == "=" then
            return actual == expected
        elseif op == "!=" then
            return actual ~= expected
        elseif op == "<" then
            return actual < expected
        elseif op == "<=" then
            return actual <= expected
        elseif op == ">" then
            return actual > expected
        elseif op == ">=" then
            return actual >= expected
        end
        return false
    end

    local left = asText(actual)
    local right = tostring(expected)
    if op == "=" then
        return left == right
    elseif op == "!=" then
        return left ~= right
    elseif op == "*=" then
        return string.find(left, right, 1, true) ~= nil
    elseif op == "^=" then
        return string.sub(left, 1, #right) == right
    elseif op == "$=" then
        return right == "" or string.sub(left, -#right) == right
    end
    return false
end

local function stepMatches(instance, step)
    if step.type and step.type ~= "*" then
        local ok, isClass = pcall(function()
            return instance:IsA(step.type)
        end)
        if not (ok and isClass) then
            return false
        end
    end
    if step.name and instance.Name ~= step.name then
        return false
    end
    if step.attrs then
        for _, condition in ipairs(step.attrs) do
            if not attributeMatches(instance, condition) then
                return false
            end
        end
    end
    return true
end

local function runSelector()
    local current = { root }

    for _, step in ipairs(steps) do
        local nextSet = {}
        local seen = {}

        for _, parent in ipairs(current) do
            local candidates
            if step.combinator == "child" then
                candidates = parent:GetChildren()
            else
                candidates = parent:GetDescendants()
            end

            for _, candidate in ipairs(candidates) do
                pace()
                if not seen[candidate] and stepMatches(candidate, step) then
                    seen[candidate] = true
                    nextSet[#nextSet + 1] = candidate
                    if #nextSet >= MAX_WORKING_SET then
                        break
                    end
                end
            end
            if #nextSet >= MAX_WORKING_SET then
                break
            end
        end

        current = nextSet
        if #current == 0 then
            break
        end
    end

    return current
end

local function plainFilters(instance)
    if nameFilter and not string.find(string.lower(instance.Name), nameFilter, 1, true) then
        return false
    end
    if classFilter then
        local ok, isClass = pcall(function()
            return instance:IsA(classFilter)
        end)
        if not (ok and isClass) then
            return false
        end
    end
    return true
end

local function describe(instance)
    local entry = {
        path = instance:GetFullName(),
        className = instance.ClassName,
    }
    if #wanted > 0 then
        local values = {}
        for _, name in ipairs(wanted) do
            local found, value = readProperty(instance, name)
            if not found then
                values[name] = "<not available>"
            else
                local kind = typeof(value)
                if kind == "string" or kind == "number" or kind == "boolean" then
                    values[name] = value
                else
                    values[name] = asText(value)
                end
            end
        end
        entry.values = values
    end
    return entry
end

local results = {}
local truncated = false

if steps then
    local matched = runSelector()
    for _, instance in ipairs(matched) do
        if plainFilters(instance) then
            if #results >= limit then
                truncated = true
                break
            end
            results[#results + 1] = describe(instance)
        end
    end
else
    for _, instance in ipairs(root:GetDescendants()) do
        pace()
        if plainFilters(instance) then
            if #results >= limit then
                truncated = true
                break
            end
            results[#results + 1] = describe(instance)
        end
    end
end

return {
    root = root:GetFullName(),
    scanned = scanned,
    count = #results,
    truncated = truncated,
    results = results,
}
