-- Recipe: Playing animations
-- Description: Lists the animation tracks that a character is playing right now, with id, priority, speed and progress.
-- Args: player (string, optional, the name of a player, default you)

local Players = game:GetService("Players")

local function read(instance, name)
    local ok, value = pcall(function()
        return instance[name]
    end)
    if ok then
        return value
    end
    return nil
end

local player = Players.LocalPlayer
if type(args.player) == "string" and args.player ~= "" then
    player = Players:FindFirstChild(args.player)
    if not player then
        return { error = "No player called " .. args.player .. "." }
    end
end
if not player then
    return { error = "There is no local player." }
end

local character = read(player, "Character")
if not character then
    return { error = player.Name .. " has no character right now." }
end

local controller = character:FindFirstChildOfClass("Humanoid") or character:FindFirstChildOfClass("AnimationController")
if not controller then
    return { error = "The character of " .. player.Name .. " has no Humanoid or AnimationController." }
end

local animator = controller:FindFirstChildOfClass("Animator")
if not animator then
    return { error = "The character of " .. player.Name .. " has no Animator." }
end

local okTracks, tracks = pcall(function()
    return animator:GetPlayingAnimationTracks()
end)
if not okTracks then
    return { error = "Could not read the animation tracks: " .. tostring(tracks) }
end

local function round(number)
    if type(number) ~= "number" then
        return number
    end
    return math.floor(number * 100 + 0.5) / 100
end

local list = {}
for _, track in ipairs(tracks) do
    local animation = read(track, "Animation")
    local priority = read(track, "Priority")
    list[#list + 1] = {
        name = read(track, "Name"),
        animationId = animation and read(animation, "AnimationId") or nil,
        priority = priority ~= nil and tostring(priority) or nil,
        length = round(read(track, "Length")),
        speed = round(read(track, "Speed")),
        weight = round(read(track, "WeightCurrent")),
        timePosition = round(read(track, "TimePosition")),
        looped = read(track, "Looped"),
    }
end

return { player = player.Name, count = #list, tracks = list }
