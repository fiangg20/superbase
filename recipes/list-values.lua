-- Recipe: List values
-- Description: Lists the value objects (IntValue, StringValue, BoolValue, ObjectValue and so on) under a path, with their current value.
-- Args: path (string, optional, dotted path to search under, default the whole game), contains (string, optional, filter on the path), limit (number, default 100)

local contains = type(args.contains) == "string" and string.lower(args.contains) or nil
local limit = tonumber(args.limit) or 100

local root = game
if type(args.path) == "string" and args.path ~= "" then
    local first = true
    for part in string.gmatch(args.path, "[^%.]+") do
        if not (first and part == "game") then
            root = root:FindFirstChild(part)
            if not root then
                return { error = "Nothing found at " .. args.path .. "." }
            end
        end
        first = false
    end
end

local function show(value)
    local kind = typeof(value)
    if kind == "string" or kind == "number" or kind == "boolean" then
        return value
    end
    if kind == "Instance" then
        return value:GetFullName()
    end
    if value == nil then
        return nil
    end
    return tostring(value)
end

local found = {}
local total = 0

for _, instance in ipairs(root:GetDescendants()) do
    if instance:IsA("ValueBase") then
        local path = instance:GetFullName()
        if not contains or string.find(string.lower(path), contains, 1, true) then
            total = total + 1
            if #found < limit then
                local ok, value = pcall(function()
                    return instance.Value
                end)
                found[#found + 1] = { path = path, class = instance.ClassName, value = ok and show(value) or nil }
            end
        end
    end
end

return { total = total, returned = #found, values = found }
