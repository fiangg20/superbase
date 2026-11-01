-- Superbase snippet: save the state of part of the game and compare it later.
-- The MCP server puts "local args = ..." in front of this file.
-- Arguments: args.action ("take", "diff", "list" or "delete"), args.name (slot name, default "default"),
-- args.path (root, default game.Workspace), args.depth (1 to 10, default 4), args.properties (property names to
-- record, optional), args.max_instances (default 1500, at most 5000), args.keep (diff: replace the saved
-- snapshot with the new state), args.limit (diff: entries per list, default 50, at most 200).
-- Snapshots live in the executor's memory (getgenv), so they are gone when the game is left.

local genv = (getgenv and getgenv()) or _G
genv.__SuperbaseSnapshots = genv.__SuperbaseSnapshots or {}
local store = genv.__SuperbaseSnapshots

local MAX_SLOTS = 10

-- Properties that are recorded for each kind of instance, when args.properties is not given.
local CLASS_PROPERTIES = {
    { "BasePart", { "Position", "Size", "Anchored", "CanCollide", "Transparency", "Color", "Material" } },
    { "GuiObject", { "Visible", "Position", "Size", "BackgroundTransparency" } },
    { "TextLabel", { "Text" } },
    { "TextButton", { "Text" } },
    { "TextBox", { "Text" } },
    { "ValueBase", { "Value" } },
    { "Humanoid", { "Health", "MaxHealth", "WalkSpeed" } },
    { "ProximityPrompt", { "Enabled", "ActionText" } },
    { "BaseScript", { "Disabled" } },
}

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

local function number(value)
    if value ~= value then
        return "nan"
    elseif value == math.huge then
        return "inf"
    elseif value == -math.huge then
        return "-inf"
    end
    local text = string.format("%.3f", value)
    text = text:gsub("(%..-)0+$", "%1")
    text = text:gsub("%.$", "")
    if text == "-0" then
        text = "0"
    end
    return text
end

-- A value as text, rounded, so tiny physics jitter does not show up as a change.
local function format(value)
    local kind = typeof(value)
    if kind == "number" then
        return number(value)
    elseif kind == "Instance" then
        return value:GetFullName()
    elseif kind == "Vector3" then
        return number(value.X) .. ", " .. number(value.Y) .. ", " .. number(value.Z)
    elseif kind == "Vector2" then
        return number(value.X) .. ", " .. number(value.Y)
    elseif kind == "Color3" then
        return math.floor(value.R * 255 + 0.5) .. ", " .. math.floor(value.G * 255 + 0.5) .. ", " .. math.floor(value.B * 255 + 0.5)
    end
    return tostring(value)
end

local function propertiesFor(instance, custom)
    if custom then
        return custom
    end
    local list, seen = {}, {}
    for _, entry in ipairs(CLASS_PROPERTIES) do
        if instance:IsA(entry[1]) then
            for _, name in ipairs(entry[2]) do
                if not seen[name] then
                    seen[name] = true
                    list[#list + 1] = name
                end
            end
        end
    end
    return list
end

-- Walks the tree and returns { entries = { key -> { class, props } }, count, truncated }.
local function collect(root, depth, maxInstances, custom)
    local entries, count, truncated = {}, 0, false

    local function record(instance, key)
        local props = { Name = instance.Name }
        for _, name in ipairs(propertiesFor(instance, custom)) do
            local ok, value = pcall(function()
                return instance[name]
            end)
            if ok and value ~= nil then
                props[name] = format(value)
            end
        end
        entries[key] = { class = instance.ClassName, props = props }
        count = count + 1
    end

    local function walk(instance, key, level)
        if count >= maxInstances then
            truncated = true
            return
        end
        record(instance, key)
        if level >= depth then
            return
        end
        local used = {}
        for _, child in ipairs(instance:GetChildren()) do
            local name = child.Name
            used[name] = (used[name] or 0) + 1
            -- Children with the same name get a number, in the order the game lists them.
            local label = used[name] > 1 and (name .. "#" .. used[name]) or name
            walk(child, key == "" and label or (key .. "." .. label), level + 1)
        end
    end

    walk(root, "", 0)
    return { entries = entries, count = count, truncated = truncated }
end

local function sortedKeys(map)
    local keys = {}
    for key in pairs(map) do
        keys[#keys + 1] = key
    end
    table.sort(keys)
    return keys
end

local action = args.action or "take"
local name = args.name
if name == nil or name == "" then
    name = "default"
end
name = tostring(name)

if action == "list" then
    local slots = {}
    for _, slotName in ipairs(sortedKeys(store)) do
        local slot = store[slotName]
        slots[#slots + 1] = {
            name = slotName,
            path = slot.path,
            instances = slot.count,
            depth = slot.depth,
            ageSeconds = os.time() - slot.takenAt,
            truncated = slot.truncated,
        }
    end
    return { count = #slots, snapshots = slots }
end

if action == "delete" then
    if store[name] == nil then
        return { error = "There is no snapshot called '" .. name .. "'." }
    end
    store[name] = nil
    return { deleted = name }
end

if action ~= "take" and action ~= "diff" then
    return { error = "Unknown action '" .. tostring(action) .. "'. Use take, diff, list or delete." }
end

local saved = store[name]
local path, depth, custom, maxInstances

if action == "diff" then
    if not saved then
        return { error = "There is no snapshot called '" .. name .. "'. Take one first." }
    end
    path, depth, custom, maxInstances = saved.path, saved.depth, saved.custom, saved.maxInstances
else
    path = type(args.path) == "string" and args.path ~= "" and args.path or "game.Workspace"
    depth = math.max(1, math.min(tonumber(args.depth) or 4, 10))
    custom = nil
    if type(args.properties) == "table" and #args.properties > 0 then
        custom = {}
        for _, property in ipairs(args.properties) do
            custom[#custom + 1] = tostring(property)
        end
    end
    maxInstances = math.max(1, math.min(tonumber(args.max_instances) or 1500, 5000))
    if saved == nil then
        local used = 0
        for _ in pairs(store) do
            used = used + 1
        end
        if used >= MAX_SLOTS then
            return { error = "There are already " .. MAX_SLOTS .. " snapshots. Delete one with the delete action first." }
        end
    end
end

local root, missing = resolvePath(path)
if not root then
    return { error = "Instance not found at segment: " .. tostring(missing) }
end

local current = collect(root, depth, maxInstances, custom)
local slot = {
    path = path,
    depth = depth,
    custom = custom,
    maxInstances = maxInstances,
    takenAt = os.time(),
    entries = current.entries,
    count = current.count,
    truncated = current.truncated,
}

if action == "take" then
    store[name] = slot
    local result = { saved = name, path = path, depth = depth, instances = current.count, truncated = current.truncated }
    if current.truncated then
        result.note = "The tree is bigger than max_instances, so only the first " .. current.count .. " instances were recorded."
    end
    return result
end

-- diff
local limit = math.max(1, math.min(tonumber(args.limit) or 50, 200))
local before, after = saved.entries, current.entries
local added, removed, changed = {}, {}, {}
-- Paths in the result start with the name of the root, so they read like paths in the game.
local function display(key)
    return key == "" and root.Name or (root.Name .. "." .. key)
end
local counts = { added = 0, removed = 0, changed = 0 }

for _, key in ipairs(sortedKeys(after)) do
    local now = after[key]
    local old = before[key]
    local label = display(key)
    if not old then
        counts.added = counts.added + 1
        if #added < limit then
            added[#added + 1] = { path = label, className = now.class }
        end
    else
        if old.class ~= now.class then
            counts.changed = counts.changed + 1
            if #changed < limit then
                changed[#changed + 1] = { path = label, property = "ClassName", before = old.class, after = now.class }
            end
        end
        for _, property in ipairs(sortedKeys(now.props)) do
            if old.props[property] ~= now.props[property] then
                counts.changed = counts.changed + 1
                if #changed < limit then
                    changed[#changed + 1] = { path = label, property = property, before = old.props[property], after = now.props[property] }
                end
            end
        end
        for _, property in ipairs(sortedKeys(old.props)) do
            if now.props[property] == nil then
                counts.changed = counts.changed + 1
                if #changed < limit then
                    changed[#changed + 1] = { path = label, property = property, before = old.props[property], after = "<not recorded>" }
                end
            end
        end
    end
end
for _, key in ipairs(sortedKeys(before)) do
    if not after[key] then
        counts.removed = counts.removed + 1
        if #removed < limit then
            removed[#removed + 1] = { path = display(key), className = before[key].class }
        end
    end
end

local result = {
    name = name,
    path = path,
    ageSeconds = os.time() - saved.takenAt,
    instancesBefore = saved.count,
    instancesAfter = current.count,
    counts = counts,
    unchanged = counts.added == 0 and counts.removed == 0 and counts.changed == 0,
    added = added,
    removed = removed,
    changed = changed,
    listsCut = counts.added > #added or counts.removed > #removed or counts.changed > #changed,
    kept = args.keep == true,
}
if saved.truncated or current.truncated then
    result.note = "The tree is bigger than max_instances, so the comparison only covers the first instances."
end
if args.keep == true then
    store[name] = slot
end
return result
