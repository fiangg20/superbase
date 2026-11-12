-- Recipe: List NPCs
-- Description: Lists the humanoids in the workspace that are not player characters, with health, position and distance from you, nearest first.
-- Args: contains (string, optional, filter on the name or path), limit (number, default 50)

local contains = type(args.contains) == "string" and string.lower(args.contains) or nil
local limit = tonumber(args.limit) or 50
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

local playerCharacters = {}
for _, player in ipairs(Players:GetPlayers()) do
    local character = read(player, "Character")
    if character then
        playerCharacters[character] = true
    end
end

local function positionOf(model)
    local part = model:FindFirstChild("HumanoidRootPart")
    if not part then
        part = read(model, "PrimaryPart")
    end
    if not part then
        part = model:FindFirstChildWhichIsA("BasePart")
    end
    return part and read(part, "Position") or nil
end

local here = nil
local localPlayer = Players.LocalPlayer
local myCharacter = localPlayer and read(localPlayer, "Character")
if myCharacter then
    here = positionOf(myCharacter)
end

local function round(number)
    return math.floor(number * 10 + 0.5) / 10
end

local found = {}
for _, instance in ipairs(workspace:GetDescendants()) do
    if instance:IsA("Humanoid") then
        local model = instance.Parent
        if model and not playerCharacters[model] then
            local path = model:GetFullName()
            if not contains or string.find(string.lower(path), contains, 1, true) then
                local item = { name = model.Name, path = path, health = read(instance, "Health"), maxHealth = read(instance, "MaxHealth") }
                local position = positionOf(model)
                if position then
                    item.position = { x = round(position.X), y = round(position.Y), z = round(position.Z) }
                    if here then
                        local dx, dy, dz = position.X - here.X, position.Y - here.Y, position.Z - here.Z
                        item.distance = round(math.sqrt(dx * dx + dy * dy + dz * dz))
                    end
                end
                found[#found + 1] = item
            end
        end
    end
end

table.sort(found, function(a, b)
    if a.distance and b.distance then
        return a.distance < b.distance
    end
    if a.distance or b.distance then
        return a.distance ~= nil
    end
    return a.path < b.path
end)

local shown = {}
for index = 1, math.min(#found, limit) do
    shown[index] = found[index]
end

return { total = #found, returned = #shown, npcs = shown }
