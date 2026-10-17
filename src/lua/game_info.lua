-- Superbase snippet: overview of the running game.
-- The MCP server puts "local args = ..." in front of this file.

local Players = game:GetService("Players")
local Stats = game:GetService("Stats")
local MarketplaceService = game:GetService("MarketplaceService")

local info = {
    placeId = game.PlaceId,
    gameId = game.GameId,
    jobId = game.JobId,
    name = game.Name,
}

local productOk, product = pcall(function()
    return MarketplaceService:GetProductInfo(game.PlaceId)
end)
if productOk and type(product) == "table" then
    info.placeName = product.Name
    if product.Creator then
        info.creator = product.Creator.Name
    end
end

local localPlayer = Players.LocalPlayer
if localPlayer then
    info.localPlayer = {
        name = localPlayer.Name,
        displayName = localPlayer.DisplayName,
        userId = localPlayer.UserId,
        hasCharacter = localPlayer.Character ~= nil,
    }
end

local players = {}
local allPlayers = Players:GetPlayers()
for _, player in ipairs(allPlayers) do
    if #players >= 50 then
        break
    end
    players[#players + 1] = {
        name = player.Name,
        displayName = player.DisplayName,
        userId = player.UserId,
    }
end
info.playerCount = #allPlayers
info.maxPlayers = Players.MaxPlayers
info.players = players

local performance = {}
pcall(function()
    performance.physicsFps = math.floor(workspace:GetRealPhysicsFPS() + 0.5)
end)
pcall(function()
    performance.memoryMb = math.floor(Stats:GetTotalMemoryUsageMb() + 0.5)
end)
pcall(function()
    if localPlayer then
        performance.pingMs = math.floor(localPlayer:GetNetworkPing() * 1000 + 0.5)
    end
end)
info.performance = performance

return info
