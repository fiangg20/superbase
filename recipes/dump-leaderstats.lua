-- Recipe: Dump leaderstats
-- Description: Shows the leaderstats values of every player in the server.
-- Args: none

local result = {}
for _, player in ipairs(game:GetService("Players"):GetPlayers()) do
    local values = {}
    local stats = player:FindFirstChild("leaderstats")
    if stats then
        for _, child in ipairs(stats:GetChildren()) do
            local ok, value = pcall(function()
                return child.Value
            end)
            if ok then
                values[child.Name] = value
            end
        end
    end
    result[#result + 1] = { player = player.Name, hasLeaderstats = stats ~= nil, values = values }
end

return { players = #result, stats = result }
