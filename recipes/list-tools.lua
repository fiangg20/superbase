-- Recipe: List tools
-- Description: Lists the Tool objects you can find: in your backpack, equipped, in the StarterPack and lying in the workspace.
-- Args: contains (string, optional, filter on the tool name), limit (number, default 100)

local contains = type(args.contains) == "string" and string.lower(args.contains) or nil
local limit = tonumber(args.limit) or 100
local Players = game:GetService("Players")
local player = Players.LocalPlayer

local function read(instance, name)
    local ok, value = pcall(function()
        return instance[name]
    end)
    if ok then
        return value
    end
    return nil
end

local seen = {}
local found = {}
local total = 0

local function add(tool, where)
    if seen[tool] then
        return
    end
    seen[tool] = true
    if contains and not string.find(string.lower(tool.Name), contains, 1, true) then
        return
    end
    total = total + 1
    if #found < limit then
        local tip = read(tool, "ToolTip")
        found[#found + 1] = {
            name = tool.Name,
            where = where,
            path = tool:GetFullName(),
            canBeDropped = read(tool, "CanBeDropped"),
            requiresHandle = read(tool, "RequiresHandle"),
            toolTip = (tip ~= nil and tip ~= "") and tip or nil,
        }
    end
end

local function addChildren(container, where)
    if not container then
        return
    end
    for _, child in ipairs(container:GetChildren()) do
        if child:IsA("Tool") then
            add(child, where)
        end
    end
end

if player then
    addChildren(player:FindFirstChildOfClass("Backpack"), "backpack")
    addChildren(read(player, "Character"), "equipped")
end

local okPack, starterPack = pcall(function()
    return game:GetService("StarterPack")
end)
if okPack then
    addChildren(starterPack, "starterPack")
end

for _, instance in ipairs(workspace:GetDescendants()) do
    if instance:IsA("Tool") then
        add(instance, "workspace")
    end
end

return { total = total, returned = #found, tools = found }
