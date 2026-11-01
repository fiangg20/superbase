-- Superbase snippet: performance numbers of the running game.
-- The MCP server puts "local args = ..." in front of this file.
-- Arguments: args.sample_seconds (how long frames are measured, 0.5 to 5, default 1.5), args.memory ("summary" or
-- "detail", default summary: detail adds the memory per category).

local RunService = game:GetService("RunService")
local Stats = game:GetService("Stats")
local Players = game:GetService("Players")

local function round(value, places)
    local scale = 10 ^ (places or 1)
    return math.floor(value * scale + 0.5) / scale
end

local function safe(fn)
    local ok, value = pcall(fn)
    if ok and type(value) == "number" and value == value then
        return value
    end
    return nil
end

local seconds = math.max(0.5, math.min(tonumber(args.sample_seconds) or 1.5, 5))
local report = { sampleSeconds = seconds }

-- Frames: measured on the render step for a moment.
local frames = {}
local connection = RunService.RenderStepped:Connect(function(delta)
    frames[#frames + 1] = delta
end)
task.wait(seconds)
connection:Disconnect()

if #frames > 0 then
    local total, worst = 0, 0
    for _, delta in ipairs(frames) do
        total = total + delta
        if delta > worst then
            worst = delta
        end
    end
    local sorted = {}
    for index, delta in ipairs(frames) do
        sorted[index] = delta
    end
    table.sort(sorted, function(a, b)
        return a > b
    end)
    -- The slowest 1 percent of the frames, at least one frame.
    local slowCount = math.max(1, math.floor(#sorted / 100))
    local slowTotal = 0
    for index = 1, slowCount do
        slowTotal = slowTotal + sorted[index]
    end
    local stutters = 0
    for _, delta in ipairs(frames) do
        if delta > 0.05 then
            stutters = stutters + 1
        end
    end
    report.frames = {
        count = #frames,
        avgFps = total > 0 and round(#frames / total) or nil,
        minFps = worst > 0 and round(1 / worst) or nil,
        onePercentLowFps = slowTotal > 0 and round(slowCount / slowTotal) or nil,
        avgFrameMs = round(total / #frames * 1000, 2),
        worstFrameMs = round(worst * 1000, 1),
        stutters = stutters,
    }
else
    report.frames = { count = 0, note = "No frames were rendered. The game window may be minimized or in the background." }
end

local physics = safe(function()
    return workspace:GetRealPhysicsFPS()
end)
if physics then
    report.physicsFps = round(physics)
end

-- Memory.
local memory = {}
memory.totalMb = safe(function()
    return Stats:GetTotalMemoryUsageMb()
end)
if memory.totalMb then
    memory.totalMb = round(memory.totalMb)
end
if args.memory == "detail" then
    local tags = {}
    pcall(function()
        for _, tag in ipairs(Enum.DeveloperMemoryTag:GetEnumItems()) do
            local used = safe(function()
                return Stats:GetMemoryUsageMbForTag(tag)
            end)
            if used and used >= 0.5 then
                tags[#tags + 1] = { name = tostring(tag.Name), mb = round(used) }
            end
        end
    end)
    table.sort(tags, function(a, b)
        return a.mb > b.mb
    end)
    local top = {}
    for index = 1, math.min(#tags, 12) do
        top[index] = tags[index]
    end
    memory.categories = top
end
report.memory = memory

-- Network.
local network = {
    pingMs = safe(function()
        return Players.LocalPlayer:GetNetworkPing() * 1000
    end),
    receiveKbps = safe(function()
        return Stats.DataReceiveKbps
    end),
    sendKbps = safe(function()
        return Stats.DataSendKbps
    end),
    dataPingMs = safe(function()
        return Stats.Network.ServerStatsItem["Data Ping"]:GetValue()
    end),
}
for key, value in pairs(network) do
    network[key] = round(value)
end
report.network = network

-- The world.
local world = {
    instances = safe(function()
        return Stats.InstanceCount
    end),
    primitives = safe(function()
        return Stats.PrimitivesCount
    end),
    movingPrimitives = safe(function()
        return Stats.MovingPrimitivesCount
    end),
    contacts = safe(function()
        return Stats.ContactsCount
    end),
    heartbeatMs = safe(function()
        return Stats.HeartbeatTimeMs
    end),
    physicsStepMs = safe(function()
        return Stats.PhysicsStepTimeMs
    end),
    players = #Players:GetPlayers(),
}
for key, value in pairs(world) do
    world[key] = round(value, 2)
end
report.world = world

pcall(function()
    report.renderQuality = tostring(settings().Rendering.QualityLevel)
end)

-- A short reading of the numbers, so the AI does not have to guess what is high.
local notes = {}
local frameInfo = report.frames
if frameInfo.avgFps and frameInfo.avgFps < 30 then
    notes[#notes + 1] = "Low frame rate (" .. frameInfo.avgFps .. " FPS on average)."
end
if frameInfo.stutters and frameInfo.stutters > 0 then
    notes[#notes + 1] = frameInfo.stutters .. " frame(s) took longer than 50 ms (worst " .. frameInfo.worstFrameMs .. " ms)."
end
if memory.totalMb and memory.totalMb > 3000 then
    notes[#notes + 1] = "High memory use (" .. memory.totalMb .. " MB)."
end
if network.pingMs and network.pingMs > 250 then
    notes[#notes + 1] = "High ping (" .. network.pingMs .. " ms)."
end
if physics and physics < 40 then
    notes[#notes + 1] = "The physics step runs slowly (" .. round(physics) .. " FPS)."
end
report.notes = notes

return report
