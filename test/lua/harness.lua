-- A small mock of the Roblox API, enough to run the Superbase snippets under plain Lua 5.3 or newer.
-- It is not Roblox: it checks the logic of the snippets (selectors, filters, formatting, argument
-- handling), not how a real executor behaves. SUPERBASE_LUA_DIR points at src/lua.
local SNIPPETS = (os.getenv("SUPERBASE_LUA_DIR") or "src/lua"):gsub("[/\\]$", "") .. "/"

local inherits = {
    Folder = "Instance", Model = "PVInstance", PVInstance = "Instance",
    Part = "BasePart", BasePart = "PVInstance",
    LuaSourceContainer = "Instance", BaseScript = "LuaSourceContainer",
    Script = "BaseScript", LocalScript = "BaseScript", ModuleScript = "LuaSourceContainer",
    BaseRemoteEvent = "Instance", RemoteEvent = "BaseRemoteEvent", RemoteFunction = "Instance",
    GuiBase2d = "Instance", LayerCollector = "GuiBase2d", ScreenGui = "LayerCollector",
    GuiObject = "GuiBase2d", Frame = "GuiObject", GuiButton = "GuiObject", TextButton = "GuiButton",
    TextBox = "GuiObject", ClickDetector = "Instance", ProximityPrompt = "Instance",
    PlayerGui = "Instance", Player = "Instance", Players = "Instance", DataModel = "Instance",
    Workspace = "Instance", GuiService = "Instance",
    Humanoid = "Instance", Tool = "Instance", Team = "Instance", Backpack = "Instance",
    ValueBase = "Instance", IntValue = "ValueBase", StringValue = "ValueBase",
    TextLabel = "GuiObject",
}

-- Members that exist in Roblox but are nil, so reading them must not raise an error.
local nilMembers = { Player = { Character = true, Team = true } }

local function classIs(class, target)
    while class do
        if class == target then return true end
        class = inherits[class]
    end
    return false
end

local Inst = {}
local methods = {}

function methods.IsA(self, name) return classIs(rawget(self, "ClassName"), name) end
function methods.GetChildren(self)
    local out = {}
    for i, c in ipairs(rawget(self, "_children")) do out[i] = c end
    return out
end
function methods.GetDescendants(self)
    local out = {}
    local function walk(node)
        for _, c in ipairs(rawget(node, "_children")) do
            out[#out + 1] = c
            walk(c)
        end
    end
    walk(self)
    return out
end
function methods.GetFullName(self)
    local parts, node = {}, self
    while node and rawget(node, "ClassName") ~= "DataModel" do
        table.insert(parts, 1, rawget(node, "Name"))
        node = rawget(node, "Parent")
    end
    return table.concat(parts, ".")
end
function methods.FindFirstChild(self, name)
    for _, c in ipairs(rawget(self, "_children")) do
        if c.Name == name then return c end
    end
    return nil
end
function methods.FindFirstChildOfClass(self, class)
    for _, c in ipairs(rawget(self, "_children")) do
        if rawget(c, "ClassName") == class then return c end
    end
    return nil
end
function methods.FindFirstAncestorWhichIsA(self, class)
    local node = rawget(self, "Parent")
    while node do
        if classIs(rawget(node, "ClassName"), class) then return node end
        node = rawget(node, "Parent")
    end
    return nil
end
function methods.GetAttribute(self, name) return rawget(self, "_attrs")[name] end
function methods.GetAttributes(self)
    local out = {}
    for k, v in pairs(rawget(self, "_attrs")) do out[k] = v end
    return out
end
function methods.FindFirstChildWhichIsA(self, class, recursive)
    for _, c in ipairs(rawget(self, "_children")) do
        if classIs(rawget(c, "ClassName"), class) then return c end
    end
    if recursive then
        for _, c in ipairs(rawget(self, "_children")) do
            local found = methods.FindFirstChildWhichIsA(c, class, true)
            if found then return found end
        end
    end
    return nil
end
function methods.GetPlayers(self)
    local out = {}
    for _, c in ipairs(rawget(self, "_children")) do
        if rawget(c, "ClassName") == "Player" then out[#out + 1] = c end
    end
    return out
end
local extraServices = {}
function methods.GetService(self, name)
    local found = self:FindFirstChild(name)
    if found then return found end
    return extraServices[name]
end
function methods.GetGuiInset(self) return { X = 0, Y = 36 } end
-- Like Roblox: capturing focus clears the text when ClearTextOnFocus is on.
function methods.CaptureFocus(self)
    rawset(self, "_focused", true)
    if rawget(self, "ClearTextOnFocus") ~= false then rawset(self, "Text", "") end
end
function methods.ReleaseFocus(self, submit) rawset(self, "_focused", false); rawset(self, "_submitted", submit) end

Inst.__index = function(self, key)
    if methods[key] then return methods[key] end
    if key == "Parent" then return nil end
    local optional = nilMembers[rawget(self, "ClassName")]
    if optional and optional[key] then return nil end
    error(tostring(key) .. " is not a valid member of " .. rawget(self, "ClassName"), 2)
end

local function new(class, name, props, parent)
    local inst = setmetatable({ ClassName = class, Name = name, _children = {}, _attrs = {} }, Inst)
    for k, v in pairs(props or {}) do rawset(inst, k, v) end
    if parent then
        rawset(inst, "Parent", parent)
        table.insert(rawget(parent, "_children"), inst)
    end
    return inst
end

-- Tree ------------------------------------------------------------------
local game = new("DataModel", "Game")
rawset(game, "PlaceId", 1)
local workspace = new("Workspace", "Workspace", {}, game)
local map = new("Model", "Map", {}, workspace)
new("Part", "Floor", { Anchored = true, Reflectance = 0, Size = "10, 1, 10" }, map)
new("Part", "Wall", { Anchored = false, Reflectance = 0.5, Size = "1, 8, 10" }, map)
local coins = new("Folder", "Coins", {}, workspace)
for i = 1, 60 do new("Part", "Coin" .. i, { Anchored = true, Reflectance = i / 100 }, coins) end
local npc = new("Model", "Npc", {}, workspace)
local npcPart = new("Part", "Body", { Anchored = true, Reflectance = 0 }, npc)
local detector = new("ClickDetector", "ClickDetector", {}, npcPart)
new("ProximityPrompt", "Prompt", {}, new("Part", "Door", { Anchored = true, Reflectance = 0 }, workspace))

local rs = new("Folder", "ReplicatedStorage", {}, game)
local buy = new("RemoteEvent", "Buy", {}, rs)
local getData = new("RemoteFunction", "GetData", {}, rs)
new("ModuleScript", "Utils", { Source = "local M = {}\nfunction M.addCoins(n) return n + 1 end\nreturn M\n" }, rs)
local sss = new("Folder", "ServerScriptService", {}, game)
new("Script", "Main", { Source = "print('hello world')\nlocal coins = 5\nCoins.Touched:Connect(addCoins)\n", Disabled = false }, sss)
new("LocalScript", "Client", { Source = "-- Client\nlocal Remote = game.ReplicatedStorage.Buy\nRemote:FireServer('buy', 3)\nlocal x = 10\n", Disabled = true }, rs)

local players = new("Players", "Players", {}, game)
local bob = new("Player", "Bob", { UserId = 7 }, players)
rawset(players, "LocalPlayer", bob)
local gui = new("PlayerGui", "PlayerGui", {}, bob)
local main = new("ScreenGui", "Main", { Enabled = true, IgnoreGuiInset = false }, gui)
local menu = new("Frame", "Menu", { Visible = true, AbsolutePosition = { X = 0, Y = 0 }, AbsoluteSize = { X = 300, Y = 200 } }, main)
local play = new("TextButton", "Play", { Text = "Play", Visible = true, AbsolutePosition = { X = 10, Y = 20 }, AbsoluteSize = { X = 100, Y = 40 } }, menu)
local hiddenFrame = new("Frame", "Shop", { Visible = false, AbsolutePosition = { X = 0, Y = 0 }, AbsoluteSize = { X = 1, Y = 1 } }, main)
new("TextButton", "Buy", { Text = "Buy sword", Visible = true, AbsolutePosition = { X = 0, Y = 0 }, AbsoluteSize = { X = 1, Y = 1 } }, hiddenFrame)
local box = new("TextBox", "NameBox", { Text = "", ClearTextOnFocus = true, Visible = true, AbsolutePosition = { X = 5, Y = 70 }, AbsoluteSize = { X = 100, Y = 30 } }, menu)
local guiService = new("GuiService", "GuiService", {}, game)

-- Globals ---------------------------------------------------------------
local env = {}
setmetatable(env, { __index = _G })
env.game = game
env.workspace = workspace
env.typeof = function(v)
    if getmetatable(v) == Inst then return "Instance" end
    if type(v) == "table" and v.__typeName then return v.__typeName end
    return type(v)
end
env.Vector3 = { new = function(x, y, z) return { __typeName = "Vector3", X = x, Y = y, Z = z } end }
env.CFrame = { new = function(x, y, z) return { __typeName = "CFrame", X = x, Y = y, Z = z, Position = { X = x, Y = y, Z = z } } end }
env.task = { wait = function() end }
local genv = {}
env.getgenv = function() return genv end
env.decompile = function(inst) return rawget(inst, "Source") end
env.Players = players
env.fired = {}
env.getconnections = function(signal)
    if signal and signal.connections then return signal.connections end
    return {}
end

local function run(file, args, overrides)
    local f = assert(io.open((file:match("^recipes/") or file:match("^roblox/")) and file or (SNIPPETS .. file), "r"))
    local src = f:read("*a")
    f:close()
    local scope = setmetatable({}, { __index = env })
    for k, v in pairs(overrides or {}) do scope[k] = v end
    local fn, err = load("local args = ...\n" .. src, "=" .. file, "t", scope)
    if not fn then error("COMPILE " .. file .. ": " .. tostring(err)) end
    local ok, result = pcall(fn, args)
    if not ok then error("RUNTIME " .. file .. ": " .. tostring(result)) end
    return result
end

local failures, checks = 0, 0
local function check(label, condition, detail)
    checks = checks + 1
    if condition then
        print("PASS  " .. label)
    else
        failures = failures + 1
        print("FAIL  " .. label .. (detail and ("  -> " .. tostring(detail)) or ""))
    end
end

local function paths(list)
    local out = {}
    for _, item in ipairs(list) do out[#out + 1] = item.path end
    return table.concat(out, ",")
end

-- Make shared handles available to the test file.
return {
    run = run, check = check, extraServices = extraServices, paths = paths, env = env, genv = genv, new = new, game = game,
    nodes = { workspace = workspace, map = map, coins = coins, npc = npc, detector = detector, buy = buy,
        getData = getData, play = play, box = box, menu = menu, main = main, bob = bob, hiddenFrame = hiddenFrame },
    report = function()
        print(string.format("\n%d checks, %d failed", checks, failures))
        os.exit(failures == 0 and 0 or 1)
    end,
}
