-- Superbase snippet: set a property on an instance (on the client).
-- The MCP server puts "local args = ..." in front of this file.
-- Arguments: args.path, args.property and args.value. A value is a string, number, boolean,
-- or a table with a type field: Vector3, Vector2, Color3 (0 to 255), Enum or Instance.

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

local function convert(value)
    if type(value) ~= "table" then
        return value
    end

    local kind = value.type
    if kind == "Vector3" then
        return Vector3.new(value.x or 0, value.y or 0, value.z or 0)
    elseif kind == "Vector2" then
        return Vector2.new(value.x or 0, value.y or 0)
    elseif kind == "Color3" then
        return Color3.fromRGB(value.r or 0, value.g or 0, value.b or 0)
    elseif kind == "Enum" then
        return Enum[tostring(value.enum)][tostring(value.name)]
    elseif kind == "Instance" then
        local target, missing = resolvePath(tostring(value.path))
        if not target then
            error("Instance not found at segment: " .. tostring(missing))
        end
        return target
    end

    error("Unsupported value type: " .. tostring(kind))
end

local instance, missing = resolvePath(tostring(args.path))
if not instance then
    return { error = "Not found at segment: " .. tostring(missing) }
end

local property = tostring(args.property)

local readOk, oldValue = pcall(function()
    return instance[property]
end)
if not readOk then
    return { error = "Unknown property: " .. property }
end

local convertOk, newValue = pcall(convert, args.value)
if not convertOk then
    return { error = tostring(newValue) }
end

local setOk, setError = pcall(function()
    instance[property] = newValue
end)
if not setOk then
    return { error = tostring(setError) }
end

return {
    path = instance:GetFullName(),
    property = property,
    oldValue = tostring(oldValue),
    newValue = tostring(instance[property]),
}
