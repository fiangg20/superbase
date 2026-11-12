-- Recipe: List interactables
-- Description: Lists the ProximityPrompts and ClickDetectors in the game, with their text, distance and whether they are enabled.
-- Args: kind (prompt, click or all, default all), contains (string, optional, filter on the path), limit (number, default 100)

local kind = args.kind
if kind ~= "prompt" and kind ~= "click" then
    kind = "all"
end
local contains = type(args.contains) == "string" and string.lower(args.contains) or nil
local limit = tonumber(args.limit) or 100
local found = {}
local total = 0

local function read(instance, name)
    local ok, value = pcall(function()
        return instance[name]
    end)
    if ok then
        return value
    end
    return nil
end

for _, instance in ipairs(game:GetDescendants()) do
    local isPrompt = kind ~= "click" and instance:IsA("ProximityPrompt")
    local isClick = kind ~= "prompt" and instance:IsA("ClickDetector")
    if isPrompt or isClick then
        local path = instance:GetFullName()
        if not contains or string.find(string.lower(path), contains, 1, true) then
            total = total + 1
            if #found < limit then
                local item = { path = path, class = instance.ClassName, maxDistance = read(instance, "MaxActivationDistance") }
                if isPrompt then
                    item.actionText = read(instance, "ActionText")
                    item.objectText = read(instance, "ObjectText")
                    item.holdDuration = read(instance, "HoldDuration")
                    item.enabled = read(instance, "Enabled")
                    local key = read(instance, "KeyboardKeyCode")
                    item.key = key ~= nil and tostring(key) or nil
                end
                found[#found + 1] = item
            end
        end
    end
end

return { total = total, returned = #found, interactables = found }
