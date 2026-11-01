-- Recipe: List GUI text
-- Description: Lists the visible text of the local player's GUI (labels, buttons and text boxes).
-- Args: contains (string, optional, filter on the text), limit (number, default 100)

local player = game:GetService("Players").LocalPlayer
local gui = player and player:FindFirstChildOfClass("PlayerGui")
if not gui then
    return { error = "The local player has no PlayerGui." }
end

local contains = type(args.contains) == "string" and string.lower(args.contains) or nil
local limit = tonumber(args.limit) or 100
local found = {}
local total = 0

for _, instance in ipairs(gui:GetDescendants()) do
    if instance:IsA("TextLabel") or instance:IsA("TextButton") or instance:IsA("TextBox") then
        local text = instance.Text
        if text ~= "" and instance.Visible and (not contains or string.find(string.lower(text), contains, 1, true)) then
            total = total + 1
            if #found < limit then
                found[#found + 1] = { path = instance:GetFullName(), class = instance.ClassName, text = text }
            end
        end
    end
end

return { total = total, returned = #found, texts = found }
