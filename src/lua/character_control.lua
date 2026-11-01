-- Superbase snippet: move the local character.
-- The MCP server puts "local args = ..." in front of this file.
-- Arguments: args.action ("teleport" or "walk_to"), and one target: args.position ({x,y,z}), args.player (name,
-- display name or user id) or args.path (dotted path to a part or model). args.offset_y (teleport near a player or
-- instance, default 3 studs above), args.timeout (walk_to, seconds, default 10, at most 30).

local Players = game:GetService("Players")
local localPlayer = Players.LocalPlayer

local function round(value)
    return math.floor(value * 10 + 0.5) / 10
end

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

if not localPlayer or not localPlayer.Character then
    return { error = "The local player has no character right now." }
end
local character = localPlayer.Character
local root = character:FindFirstChild("HumanoidRootPart")
local humanoid = character:FindFirstChildOfClass("Humanoid")
if not root then
    return { error = "The character has no HumanoidRootPart." }
end

local function partPosition(instance)
    if instance:IsA("BasePart") then
        return instance.Position
    end
    local part = instance:FindFirstChild("HumanoidRootPart") or instance:FindFirstChildWhichIsA("BasePart", true)
    return part and part.Position or nil
end

-- Work out where to go: { x, y, z } and a text that says what the target was.
local function target()
    if type(args.position) == "table" then
        local x, y, z = tonumber(args.position.x), tonumber(args.position.y), tonumber(args.position.z)
        if not (x and y and z) then
            return nil, "'position' needs numeric x, y and z."
        end
        return { x = x, y = y, z = z }, "position"
    end

    local offset = tonumber(args.offset_y) or 3
    if args.player ~= nil and args.player ~= "" then
        local text = string.lower(tostring(args.player))
        local number = tonumber(args.player)
        local found
        for _, player in ipairs(Players:GetPlayers()) do
            if player ~= localPlayer and (player.UserId == number or string.lower(player.Name) == text or string.lower(player.DisplayName) == text) then
                found = player
                break
            end
        end
        if not found then
            return nil, "No other player matches '" .. tostring(args.player) .. "'."
        end
        local otherRoot = found.Character and found.Character:FindFirstChild("HumanoidRootPart")
        if not otherRoot then
            return nil, found.Name .. " has no character right now."
        end
        return { x = otherRoot.Position.X, y = otherRoot.Position.Y + offset, z = otherRoot.Position.Z }, "player " .. found.Name
    end

    if type(args.path) == "string" and args.path ~= "" then
        local instance, missing = resolvePath(args.path)
        if not instance then
            return nil, "Instance not found at segment: " .. tostring(missing)
        end
        local where = partPosition(instance)
        if not where then
            return nil, args.path .. " has no part to go to."
        end
        return { x = where.X, y = where.Y + offset, z = where.Z }, "instance " .. args.path
    end
    return nil, "Give a target: position, player or path."
end

local action = args.action
if action ~= "teleport" and action ~= "walk_to" then
    return { error = "Unknown action '" .. tostring(action) .. "'. Use teleport or walk_to." }
end

local goal, what = target()
if not goal then
    return { error = what }
end

local from = { x = round(root.Position.X), y = round(root.Position.Y), z = round(root.Position.Z) }

if action == "teleport" then
    character:PivotTo(CFrame.new(goal.x, goal.y, goal.z))
    return {
        action = "teleport",
        target = what,
        from = from,
        to = { x = round(root.Position.X), y = round(root.Position.Y), z = round(root.Position.Z) },
    }
end

if not humanoid then
    return { error = "The character has no Humanoid, so it cannot walk." }
end

local timeout = math.max(1, math.min(tonumber(args.timeout) or 10, 30))
local finished, reached = false, false
local connection = humanoid.MoveToFinished:Connect(function(didReach)
    finished = true
    reached = didReach
end)
humanoid:MoveTo(Vector3.new(goal.x, goal.y, goal.z))

local waited = 0
while not finished and waited < timeout do
    task.wait(0.1)
    waited = waited + 0.1
end
connection:Disconnect()

local dx, dy, dz = root.Position.X - goal.x, root.Position.Y - goal.y, root.Position.Z - goal.z
return {
    action = "walk_to",
    target = what,
    from = from,
    to = { x = round(root.Position.X), y = round(root.Position.Y), z = round(root.Position.Z) },
    reached = reached,
    timedOut = not finished,
    distanceLeft = round(math.sqrt(dx * dx + dy * dy + dz * dz)),
}
