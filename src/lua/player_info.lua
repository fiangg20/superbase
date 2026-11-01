-- Superbase snippet: players and their characters.
-- The MCP server puts "local args = ..." in front of this file.
-- Arguments: args.action ("list" or "character"), args.player (name, display name or user id, default the local
-- player), args.limit (list: default 50), args.details (list: include health, speed and tools, default false).

local Players = game:GetService("Players")
local localPlayer = Players.LocalPlayer

local function round(value, places)
    local scale = 10 ^ (places or 1)
    return math.floor(value * scale + 0.5) / scale
end

local function position(part)
    return { x = round(part.Position.X), y = round(part.Position.Y), z = round(part.Position.Z) }
end

local function rootPart(character)
    if not character then
        return nil
    end
    local root = character:FindFirstChild("HumanoidRootPart")
    if root then
        return root
    end
    local ok, primary = pcall(function()
        return character.PrimaryPart
    end)
    return ok and primary or nil
end

local function safe(fn)
    local ok, value = pcall(fn)
    if ok then
        return value
    end
    return nil
end

local localRoot = localPlayer and rootPart(localPlayer.Character) or nil

local function toolNames(container)
    local names = {}
    if not container then
        return names
    end
    for _, child in ipairs(container:GetChildren()) do
        if child:IsA("Tool") then
            names[#names + 1] = child.Name
        end
    end
    return names
end

local function describe(player, detailed)
    local info = {
        name = player.Name,
        displayName = player.DisplayName,
        userId = player.UserId,
        isLocal = player == localPlayer,
        team = safe(function()
            return player.Team and player.Team.Name or nil
        end),
    }

    local character = player.Character
    info.hasCharacter = character ~= nil
    if not character then
        return info
    end

    local root = rootPart(character)
    local humanoid = character:FindFirstChildOfClass("Humanoid")
    if root then
        info.position = position(root)
        if localRoot and root ~= localRoot then
            local dx = root.Position.X - localRoot.Position.X
            local dy = root.Position.Y - localRoot.Position.Y
            local dz = root.Position.Z - localRoot.Position.Z
            info.distance = round(math.sqrt(dx * dx + dy * dy + dz * dz))
        end
    end
    if humanoid then
        info.health = round(humanoid.Health)
        info.maxHealth = round(humanoid.MaxHealth)
        if detailed then
            info.walkSpeed = safe(function()
                return round(humanoid.WalkSpeed)
            end)
            info.jumpPower = safe(function()
                if humanoid.UseJumpPower then
                    return round(humanoid.JumpPower)
                end
                return nil
            end)
            info.jumpHeight = safe(function()
                if not humanoid.UseJumpPower then
                    return round(humanoid.JumpHeight)
                end
                return nil
            end)
            info.state = safe(function()
                return tostring(humanoid:GetState())
            end)
            info.sitting = safe(function()
                return humanoid.Sit
            end)
            info.rigType = safe(function()
                return tostring(humanoid.RigType)
            end)
        end
    end

    if detailed then
        info.equipped = toolNames(character)
        info.backpack = toolNames(player:FindFirstChild("Backpack"))
        local stats = player:FindFirstChild("leaderstats")
        if stats then
            local values = {}
            for _, child in ipairs(stats:GetChildren()) do
                if child:IsA("ValueBase") then
                    values[child.Name] = safe(function()
                        return child.Value
                    end)
                end
            end
            info.leaderstats = values
        end
        info.attributes = safe(function()
            local out, any = {}, false
            for key, value in pairs(player:GetAttributes()) do
                local kind = typeof(value)
                if kind == "number" or kind == "string" or kind == "boolean" then
                    out[key] = value
                else
                    out[key] = tostring(value)
                end
                any = true
            end
            return any and out or nil
        end)
    end
    return info
end

local function findPlayer(query)
    if query == nil or query == "" then
        return localPlayer
    end
    local text = string.lower(tostring(query))
    local number = tonumber(query)
    for _, player in ipairs(Players:GetPlayers()) do
        if player.UserId == number or string.lower(player.Name) == text or string.lower(player.DisplayName) == text then
            return player
        end
    end
    for _, player in ipairs(Players:GetPlayers()) do
        if string.find(string.lower(player.Name), text, 1, true) or string.find(string.lower(player.DisplayName), text, 1, true) then
            return player
        end
    end
    return nil
end

local action = args.action or "list"

if action == "list" then
    local limit = math.max(1, math.min(tonumber(args.limit) or 50, 100))
    local all = Players:GetPlayers()
    local list = {}
    for _, player in ipairs(all) do
        if #list >= limit then
            break
        end
        list[#list + 1] = describe(player, args.details == true)
    end
    return {
        count = #all,
        returned = #list,
        truncated = #all > #list,
        maxPlayers = safe(function()
            return Players.MaxPlayers
        end),
        players = list,
    }
elseif action == "character" then
    local player = findPlayer(args.player)
    if not player then
        return { error = "No player matches '" .. tostring(args.player) .. "'. Use the list action to see the players." }
    end
    return describe(player, true)
end

return { error = "Unknown action '" .. tostring(action) .. "'. Use list or character." }
