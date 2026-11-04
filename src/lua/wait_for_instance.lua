-- Superbase snippet: wait until an instance exists, for example after a teleport or while a map loads.
-- The MCP server puts "local args = ..." in front of this file.
-- Arguments: args.path (dotted path, starting at game), args.timeout (seconds, default 10, at most 60),
--            args.class_name (optional: the instance must be of this class)

local path = tostring(args.path or "")
if path == "" then
    return { error = "'path' is empty." }
end
local timeout = math.max(0.5, math.min(60, tonumber(args.timeout) or 10))
local className = args.class_name and tostring(args.class_name) or nil

-- Returns the instance, or nil and the segment that is still missing.
local function resolve()
    local current = game
    local first = true
    for segment in string.gmatch(path, "[^%.]+") do
        if first and segment == "game" then
            first = false
        else
            first = false
            local ok, child = pcall(function()
                return current:FindFirstChild(segment)
            end)
            if not (ok and child) then
                return nil, segment
            end
            current = child
        end
    end
    return current
end

local started = os.clock()
local missing = nil
while true do
    local instance, segment = resolve()
    if instance then
        local matches = true
        if className then
            matches = select(2, pcall(function()
                return instance:IsA(className)
            end)) == true
        end
        if matches then
            return {
                found = true,
                path = instance:GetFullName(),
                className = instance.ClassName,
                waitedSeconds = math.floor((os.clock() - started) * 10) / 10,
            }
        end
        missing = "(exists, but is not a " .. className .. ")"
    else
        missing = segment
    end

    if os.clock() - started >= timeout then
        break
    end
    task.wait(0.25)
end

return {
    found = false,
    path = path,
    stillMissing = missing,
    waitedSeconds = math.floor((os.clock() - started) * 10) / 10,
}
