-- Runs every snippet against the mock in harness.lua. Started by test/lua-runtime.test.js.
local here = (arg and arg[0] or ""):match("^(.*)[/\\][^/\\]*$") or "."
local H = dofile(here .. "/harness.lua")
local run, check, paths = H.run, H.check, H.paths

-- find_instances: plain filters --------------------------------------------
local r = run("find_instances.lua", { name = "coin", limit = 5 })
check("find: name filter limit", r.count == 5 and r.truncated == true, r.count)
r = run("find_instances.lua", { class_name = "RemoteEvent" })
check("find: class filter", r.count == 1 and r.results[1].path == "ReplicatedStorage.Buy", paths(r.results))

-- find_instances: selector --------------------------------------------------
r = run("find_instances.lua", { steps = { { combinator = "descendant", type = "Part", attrs = { { prop = "Anchored", op = "=", value = false } } } } })
check("selector: Part[Anchored=false]", r.count == 1 and r.results[1].path == "Workspace.Map.Wall", paths(r.results))

r = run("find_instances.lua", { steps = {
    { combinator = "descendant", type = "Model", name = "Map", attrs = {} },
    { combinator = "child", type = "Part", attrs = {} } } })
check("selector: Model#Map > Part", r.count == 2, paths(r.results))

r = run("find_instances.lua", { steps = { { combinator = "descendant", type = "Folder", name = "Coins", attrs = {} },
    { combinator = "child", type = "Part", attrs = { { prop = "Reflectance", op = ">=", value = 0.5 } } } }, limit = 200 })
check("selector: numeric >= on Coins children", r.count == 11, r.count)

r = run("find_instances.lua", { steps = { { combinator = "descendant", type = "Part", attrs = { { prop = "Name", op = "^=", value = "Coin1" } } } }, limit = 200 })
check("selector: Name ^= Coin1 (Coin1, Coin10-19)", r.count == 11, r.count)

r = run("find_instances.lua", { steps = { { combinator = "descendant", type = "*", attrs = { { prop = "Size", op = "*=", value = "8" } } } } })
check("selector: Size *= 8", r.count == 1 and r.results[1].path == "Workspace.Map.Wall", paths(r.results))

r = run("find_instances.lua", { steps = { { combinator = "descendant", type = "Part", attrs = { { prop = "Anchored", op = "truthy" } } } }, root = "Workspace.Map" })
check("selector: truthy with root", r.count == 1 and r.results[1].path == "Workspace.Map.Floor", paths(r.results))

r = run("find_instances.lua", { steps = { { combinator = "child", type = "Part", attrs = {} } }, root = "Workspace" })
check("selector: leading child combinator", r.count == 1 and r.results[1].path == "Workspace.Door", paths(r.results))

r = run("find_instances.lua", { steps = { { combinator = "descendant", type = "Part", attrs = { { prop = "Missing", op = "=", value = 1 } } } } })
check("selector: unknown property never matches, no crash", r.count == 0)

r = run("find_instances.lua", { steps = { { combinator = "descendant", type = "Part", name = "Wall", attrs = {} } }, properties = { "Reflectance", "Anchored", "Nope" } })
check("find: properties returned", r.results[1].values.Reflectance == 0.5 and r.results[1].values.Anchored == false and r.results[1].values.Nope == "<not available>", r.results[1].values and r.results[1].values.Nope)

-- get_hierarchy -------------------------------------------------------------
r = run("get_hierarchy.lua", { root = "Workspace", depth = 2 })
check("hierarchy: shows nodes", r.tree:find("Map %[Model%]") and r.tree:find("  Floor %[Part%]") ~= nil, r.tree)
check("hierarchy: depth note", r.tree:find("deeper than depth 2") ~= nil, r.tree)
check("hierarchy: max_children note", r.tree:find("20 more children not shown") ~= nil or r.tree:find("more children not shown") ~= nil, r.tree)
r = run("get_hierarchy.lua", { root = "game", depth = 4, class_name = "ClickDetector" })
check("hierarchy: class filter keeps ancestors only", r.tree:find("ClickDetector") and not r.tree:find("Floor") and r.tree:find("Npc"), r.tree)
r = run("get_hierarchy.lua", { root = "Workspace", depth = 3, max_nodes = 10 })
check("hierarchy: node cap", r.truncated == true and r.nodes == 10, r.nodes)
r = run("get_hierarchy.lua", { root = "Nope" })
check("hierarchy: missing root", r.error ~= nil)

-- list_scripts --------------------------------------------------------------
r = run("list_scripts.lua", {})
check("list_scripts: counts", r.total == 3 and r.counts.Script == 1 and r.counts.LocalScript == 1 and r.counts.ModuleScript == 1, r.total)
check("list_scripts: disabled flag", (function() for _, s in ipairs(r.scripts) do if s.className == "LocalScript" then return s.disabled == true end end end)())
r = run("list_scripts.lua", { class_name = "ModuleScript" })
check("list_scripts: class filter", r.count == 1 and r.scripts[1].path == "ReplicatedStorage.Utils", paths(r.scripts))
r = run("list_scripts.lua", { include_hidden = true })
check("list_scripts: hidden note without APIs", r.note and r.note:find("getnilinstances") ~= nil, r.note)
local nilScript = H.new("ModuleScript", "Ghost", { Source = "-- ghost" })
r = run("list_scripts.lua", { include_hidden = true }, { getnilinstances = function() return { nilScript } end, getloadedmodules = function() return {} end, getscripts = function() return {} end })
check("list_scripts: nil instance found", r.total == 4, r.total)

-- search_scripts ------------------------------------------------------------
r = run("search_scripts.lua", { query = "addcoins" })
check("search: text mode is case insensitive", r.totalMatches == 2, r.totalMatches)
r = run("search_scripts.lua", { query = "addcoins", case_sensitive = true })
check("search: case sensitive miss", r.totalMatches == 0, r.totalMatches)
r = run("search_scripts.lua", { query = "addCoins", case_sensitive = true })
check("search: case sensitive hit", r.totalMatches == 2, r.totalMatches)
r = run("search_scripts.lua", { query = "FireServer", context_lines = 1 })
check("search: context lines", r.returned == 1 and #r.matches[1].before == 1 and #r.matches[1].after == 1 and r.matches[1].line == 3, r.returned)
r = run("search_scripts.lua", { query = "local%s+%a+%s*=", mode = "pattern" })
check("search: pattern mode", r.totalMatches >= 3 and r.mode == "pattern", r.totalMatches)
r = run("search_scripts.lua", { query = "(", mode = "pattern" })
check("search: bad pattern reported", r.error ~= nil and r.error:find("Invalid Lua pattern") ~= nil, r.error)
r = run("search_scripts.lua", { query = "coins touched", mode = "words" })
check("search: words mode ranks", r.returned == 1 and r.matches[1].path == "ServerScriptService.Main", r.returned)
r = run("search_scripts.lua", { query = "zzzz" })
check("search: no match", r.totalMatches == 0 and r.searched == 3, r.searched)
r = run("search_scripts.lua", { query = "" })
check("search: empty query", r.error ~= nil)
r = run("search_scripts.lua", { query = "hello" }, { decompile = function() return "<!DOCTYPE html><html>error</html>" end })
check("search: decompiler error page treated as unreadable, falls back to Source", r.totalMatches == 1, r.totalMatches)
r = run("search_scripts.lua", { query = "hello", max_scripts = 1 })
check("search: max_scripts flags truncation", r.truncatedScripts == true and r.searched == 1, r.searched)

-- get_script_source ---------------------------------------------------------
r = run("get_script_source.lua", { path = "ReplicatedStorage.Utils" })
check("source: decompile", r.method == "decompile" and r.length > 10, r.method)

-- gui_interact --------------------------------------------------------------
r = run("gui_interact.lua", { action = "list" })
check("gui list: visible buttons and inputs only", r.total == 2 and r.elements[1].path:find("Play") ~= nil, paths(r.elements))
r = run("gui_interact.lua", { action = "list", visible_only = false })
check("gui list: includes hidden", r.total == 3, r.total)
r = run("gui_interact.lua", { action = "list", kind = "inputs" })
check("gui list: inputs", r.total == 1 and r.elements[1].className == "TextBox", r.total)
r = run("gui_interact.lua", { action = "list", text = "sword", visible_only = false })
check("gui list: text filter", r.total == 1, r.total)

local fired = 0
H.nodes.play.Activated = { connections = { { Fire = function() fired = fired + 1 end }, { Function = function() fired = fired + 10 end } } }
H.nodes.play.MouseButton1Click = { connections = {} }
H.nodes.play.MouseButton1Down = { connections = {} }
H.nodes.play.MouseButton1Up = { connections = {} }
rawset(H.nodes.play, "Activated", H.nodes.play.Activated)
r = run("gui_interact.lua", { action = "click", path = "Players.Bob.PlayerGui.Main.Menu.Play" }, {
    getconnections = function(signal) return signal.connections end })
check("gui click: signal mode fires connections", r.method == "signal" and r.connectionsFired == 2 and fired == 11, r.error or fired)

r = run("gui_interact.lua", { action = "click", path = "Players.Bob.PlayerGui.Main.Menu" })
check("gui click: refuses non buttons", r.error and r.error:find("not a button") ~= nil, r.error)

local mouse = {}
H.extraServices.VirtualInputManager = setmetatable({}, { __index = function(_, k)
    if k == "SendMouseButtonEvent" then return function(_, x, y, button, down) mouse[#mouse + 1] = { x, y, button, down } end end
end })
r = run("gui_interact.lua", { action = "click", path = "Players.Bob.PlayerGui.Main.Menu.Play", mode = "mouse" })
check("gui click: mouse mode sends down and up at center plus inset", r.method == "mouse" and #mouse == 2 and mouse[1][1] == 60 and mouse[1][2] == 76 and mouse[1][4] == true and mouse[2][4] == false, r.error or (mouse[1] and (mouse[1][1] .. "," .. mouse[1][2])))

r = run("gui_interact.lua", { action = "click", path = "Players.Bob.PlayerGui.Main.Shop.Buy", mode = "mouse" })
check("gui click: refuses invisible button in mouse mode", r.error and r.error:find("not visible") ~= nil, r.error)

r = run("gui_interact.lua", { action = "click", path = "Players.Bob.PlayerGui.Main.Menu.Play", mode = "auto" }, { getconnections = function() return {} end, firesignal = nil })
check("gui click: auto falls back to the mouse", r.method == "mouse", r.error)

r = run("gui_interact.lua", { action = "set_text", path = "Players.Bob.PlayerGui.Main.Menu.NameBox", text = "Bob", submit = true })
check("gui set_text: sets and submits", r.text == "Bob" and r.submitted == true, r.error)
r = run("gui_interact.lua", { action = "set_text", path = "Players.Bob.PlayerGui.Main.Menu.Play", text = "x" })
check("gui set_text: refuses non TextBox", r.error ~= nil)

local clicks = 0
r = run("gui_interact.lua", { action = "trigger", path = "Workspace.Npc" }, { fireclickdetector = function() clicks = clicks + 1 end })
check("gui trigger: finds ClickDetector inside model", r.className == "ClickDetector" and clicks == 1, r.error)
local prompts = 0
r = run("gui_interact.lua", { action = "trigger", path = "Workspace.Door" }, { fireproximityprompt = function() prompts = prompts + 1 end })
check("gui trigger: ProximityPrompt", r.className == "ProximityPrompt" and prompts == 1, r.error)
r = run("gui_interact.lua", { action = "trigger", path = "Workspace.Map" })
check("gui trigger: nothing to trigger", r.error ~= nil)
r = run("gui_interact.lua", { action = "dance" })
check("gui: unknown action", r.error ~= nil)

-- remote_spy ----------------------------------------------------------------
local installed, current
isOwn = false
local currentMethod
local spyEnv = {
    hookmetamethod = function(target, name, fn) installed = fn; return function(self, ...) return "original", self, ... end end,
    getnamecallmethod = function() return currentMethod end,
    setnamecallmethod = function(m) currentMethod = m end,
    checkcaller = function() return isOwn end,
    getcallingscript = function() return H.nodes.play end,
    newcclosure = function(fn) return fn end,
}
r = run("remote_spy.lua", { action = "start", ignore = { "Noisy" }, max_calls = 100 }, spyEnv)
check("spy: start installs hook", r.active == true and r.hooked == true and installed ~= nil, r.error)

currentMethod = "FireServer"
local res = installed(H.nodes.buy, "buy", 3, { a = 1 })
check("spy: hook passes the call through", res == "original")
currentMethod = "InvokeServer"
installed(H.nodes.getData)
currentMethod = "Destroy"
installed(H.nodes.buy)
r = run("remote_spy.lua", { action = "get" }, spyEnv)
check("spy: two calls recorded, other methods ignored", r.matched == 2 and r.calls[1].method == "FireServer" and r.calls[2].method == "InvokeServer", r.matched)
check("spy: arguments rendered", r.calls[1].args[1] == '"buy"' and r.calls[1].args[2] == "3" and r.calls[1].args[3] == "{[\"a\"]=1}" and r.calls[1].argCount == 3, r.calls[1].args and table.concat(r.calls[1].args, "|"))
check("spy: caller and remote path", r.calls[1].remote == "ReplicatedStorage.Buy" and r.calls[1].caller ~= nil)
local firstId = r.calls[1].id
r = run("remote_spy.lua", { action = "get", since_id = firstId }, spyEnv)
check("spy: since_id", r.matched == 1 and r.calls[1].method == "InvokeServer", r.matched)
r = run("remote_spy.lua", { action = "get", contains = "buy" }, spyEnv)
check("spy: contains filter", r.matched == 1, r.matched)
r = run("remote_spy.lua", { action = "get", remote = "GetData" }, spyEnv)
check("spy: remote filter", r.matched == 1, r.matched)

isOwn = true
currentMethod = "FireServer"
installed(H.nodes.buy, "own")
r = run("remote_spy.lua", { action = "get" }, spyEnv)
check("spy: own calls skipped by default", r.matched == 2, r.matched)
run("remote_spy.lua", { action = "start", include_own = true }, spyEnv)
installed(H.nodes.buy, "own")
r = run("remote_spy.lua", { action = "get" }, spyEnv)
check("spy: include_own records them", r.matched == 3, r.matched)

isOwn = false
run("remote_spy.lua", { action = "start", ignore = { "Buy" } }, spyEnv)
installed(H.nodes.buy, "again")
r = run("remote_spy.lua", { action = "get" }, spyEnv)
check("spy: ignore list", r.matched == 3, r.matched)
run("remote_spy.lua", { action = "start", only = "getdata" }, spyEnv)
installed(H.nodes.getData)
installed(H.nodes.buy, "x")
r = run("remote_spy.lua", { action = "get", limit = 1 }, spyEnv)
check("spy: only filter and limit keeps newest", r.matched == 4 and r.returned == 1 and r.calls[1].name == "GetData", r.matched)
run("remote_spy.lua", { action = "stop" }, spyEnv)
installed(H.nodes.getData)
r = run("remote_spy.lua", { action = "status" }, spyEnv)
check("spy: stop keeps buffer but records nothing", r.active == false and r.buffered == 4, r.buffered)
r = run("remote_spy.lua", { action = "clear" }, spyEnv)
check("spy: clear", r.buffered == 0)
r = run("remote_spy.lua", { action = "start" }, {})
check("spy: start twice does not hook twice", r.hooked == true)

-- block / unblock
run("remote_spy.lua", { action = "start" }, spyEnv)
run("remote_spy.lua", { action = "clear" }, spyEnv)
r = run("remote_spy.lua", { action = "block" }, spyEnv)
check("spy block: needs remotes", r.error ~= nil and r.error:find("remotes") ~= nil, r.error)
r = run("remote_spy.lua", { action = "block", remotes = { "Buy" } }, spyEnv)
check("spy block: listed in status", r.blocked[1] == "Buy" and r.blockedCalls == 0, r.error)
currentMethod = "FireServer"
isOwn = false
res = installed(H.nodes.buy, "x")
check("spy block: the game's call never reaches the original", res == nil)
res = installed(H.nodes.getData)
check("spy block: other remotes still pass", res == "original")
r = run("remote_spy.lua", { action = "get" }, spyEnv)
check("spy block: the blocked call is recorded and marked", r.matched == 2 and r.calls[1].blocked == true and r.calls[2].blocked == nil and r.blockedCalls == 1, r.matched)
isOwn = true
res = installed(H.nodes.buy, "own")
check("spy block: calls from Superbase itself pass", res == "original")
run("remote_spy.lua", { action = "block", remotes = { "Buy" }, include_own = true }, spyEnv)
res = installed(H.nodes.buy, "own")
check("spy block: include_own blocks them too", res == nil)
isOwn = false
run("remote_spy.lua", { action = "unblock", remotes = { "Buy" } }, spyEnv)
res = installed(H.nodes.buy, "x")
check("spy unblock: the remote works again", res == "original")
r = run("remote_spy.lua", { action = "block", remotes = { "ReplicatedStorage.GetData", "Nope" } }, spyEnv)
check("spy block: full paths work", installed(H.nodes.getData) == nil and #r.blocked == 2)
run("remote_spy.lua", { action = "stop" }, spyEnv)
check("spy block: stays active when recording stops", installed(H.nodes.getData) == nil)
r = run("remote_spy.lua", { action = "unblock" }, spyEnv)
check("spy unblock: no names releases everything", #r.blocked == 0 and installed(H.nodes.getData) == "original")
H.genv.__SuperbaseSpy = nil
r = run("remote_spy.lua", { action = "block", remotes = { "Buy" } }, {})
check("spy block: reports missing executor APIs", r.error and r.error:find("hookmetamethod") ~= nil, r.error)
H.genv.__SuperbaseSpy = nil
r = run("remote_spy.lua", { action = "start" }, {})
check("spy: reports missing executor APIs", r.error and r.error:find("hookmetamethod") ~= nil, r.error)
r = run("remote_spy.lua", { action = "nope" }, {})
check("spy: unknown action", r.error ~= nil)

-- player_info and character_control -------------------------------------------
local new = H.new
local function makeCharacter(owner, name, x, y, z, health)
    local model = new("Model", name, {})
    local rootPart = new("Part", "HumanoidRootPart", { Position = { X = x, Y = y, Z = z } }, model)
    local humanoid = new("Humanoid", "Humanoid", {
        Health = health, MaxHealth = 100, WalkSpeed = 16, UseJumpPower = true, JumpPower = 50, Sit = false, RigType = "R15",
    }, model)
    rawset(humanoid, "GetState", function() return "Running" end)
    rawset(owner, "Character", model)
    return model, rootPart, humanoid
end

rawset(H.nodes.bob, "DisplayName", "Bobby")
r = run("player_info.lua", { action = "list" })
check("players: list without characters", r.count == 1 and r.players[1].isLocal == true and r.players[1].hasCharacter == false, r.count)

local bobModel, bobRoot, bobHumanoid = makeCharacter(H.nodes.bob, "Bob", 0, 10, 0, 80)
local alice = new("Player", "Alice", { UserId = 8, DisplayName = "Ali" }, H.env.Players)
local aliceModel = makeCharacter(alice, "Alice", 3, 10, 4, 100)
new("Tool", "Sword", {}, aliceModel)
local backpack = new("Backpack", "Backpack", {}, alice)
new("Tool", "Bow", {}, backpack)
local stats = new("Folder", "leaderstats", {}, alice)
new("IntValue", "Coins", { Value = 42 }, stats)
rawget(alice, "_attrs").Vip = true

r = run("player_info.lua", { action = "list" })
check("players: list with positions", r.count == 2 and r.players[1].position.y == 10 and r.players[2].distance == 5, r.players[2] and r.players[2].distance)
check("players: list is lean without details", r.players[2].walkSpeed == nil and r.players[2].equipped == nil)
r = run("player_info.lua", { action = "list", details = true, limit = 1 })
check("players: limit and truncated", r.returned == 1 and r.truncated == true)
r = run("player_info.lua", { action = "character", player = "ali" })
check("players: character by display name", r.name == "Alice" and r.walkSpeed == 16 and r.jumpPower == 50 and r.state == "Running", r.name)
check("players: tools and leaderstats", r.equipped[1] == "Sword" and r.backpack[1] == "Bow" and r.leaderstats.Coins == 42, r.leaderstats and r.leaderstats.Coins)
check("players: attributes", r.attributes and r.attributes.Vip == true)
r = run("player_info.lua", { action = "character" })
check("players: character defaults to local player", r.name == "Bob" and r.health == 80 and r.isLocal == true, r.name)
r = run("player_info.lua", { action = "character", player = "8" })
check("players: character by user id", r.name == "Alice")
r = run("player_info.lua", { action = "character", player = "nobody" })
check("players: unknown player is an error", r.error ~= nil and r.error:find("nobody") ~= nil)
r = run("player_info.lua", { action = "nope" })
check("players: unknown action", r.error ~= nil)

local function placeCharacter()
    rawset(bobModel, "PivotTo", function(self, cf)
        rawset(bobRoot, "Position", { X = cf.X, Y = cf.Y, Z = cf.Z })
    end)
end
placeCharacter()
r = run("character_control.lua", { action = "teleport", position = { x = 5, y = 6, z = 7 } })
check("character: teleport to position", r.to.x == 5 and r.to.y == 6 and r.to.z == 7 and r.from.y == 10, r.error or r.to.x)
r = run("character_control.lua", { action = "teleport", player = "Alice", offset_y = 2 })
check("character: teleport to player with offset", r.to.x == 3 and r.to.y == 12 and r.to.z == 4, r.error or r.to.y)
rawset(H.nodes.map:FindFirstChild("Floor"), "Position", { X = 1, Y = 2, Z = 3 })
r = run("character_control.lua", { action = "teleport", path = "game.Workspace.Map.Floor" })
check("character: teleport to an instance path", r.error == nil and r.to.x == 1 and r.to.y == 5 and r.to.z == 3, r.error or r.to.y)
r = run("character_control.lua", { action = "teleport", path = "game.Workspace.Nope" })
check("character: missing path is an error", r.error ~= nil and r.error:find("Nope") ~= nil, r.error)
r = run("character_control.lua", { action = "teleport", player = "Bob" })
check("character: cannot go to yourself", r.error ~= nil)
r = run("character_control.lua", { action = "teleport" })
check("character: target is required", r.error ~= nil and r.error:find("target") ~= nil, r.error)
r = run("character_control.lua", { action = "teleport", position = { x = 1, y = "a", z = 2 } })
check("character: position must be numeric", r.error ~= nil)
r = run("character_control.lua", { action = "fly", position = { x = 1, y = 1, z = 1 } })
check("character: unknown action", r.error ~= nil)

-- teleport with a pivot that is 1.5 studs above the root part (like an R6 rig): the root must land on the target.
local vectorMeta = {}
local function vec(x, y, z) return setmetatable({ X = x, Y = y, Z = z }, vectorMeta) end
vectorMeta.__sub = function(a, b) return vec(a.X - b.X, a.Y - b.Y, a.Z - b.Z) end
vectorMeta.__add = function(a, b) return vec(a.X + b.X, a.Y + b.Y, a.Z + b.Z) end
local rotationMeta = { __add = function(rot, v) return { X = v.X, Y = v.Y, Z = v.Z, kept = rot.rotation } end }
local function pivotNow()
    local p = rawget(bobRoot, "Position")
    local pos = vec(p.X, p.Y + 1.5, p.Z)
    return setmetatable({ Position = pos, rotation = "facing-east" }, { __sub = function(self) return setmetatable({ rotation = self.rotation }, rotationMeta) end })
end
rawset(bobModel, "GetPivot", pivotNow)
H.env.Vector3 = { new = function(x, y, z) return vec(x, y, z) end }
rawset(bobModel, "PivotTo", function(self, cf) rawset(bobRoot, "Position", { X = cf.X, Y = cf.Y - 1.5, Z = cf.Z }) rawset(self, "_lastKept", cf.kept) end)
rawset(bobRoot, "Position", vec(0, 10, 0))
r = run("character_control.lua", { action = "teleport", position = { x = 5, y = 20, z = 7 } })
check("character: teleport puts the root part on the target", r.to.x == 5 and r.to.y == 20 and r.to.z == 7, r.error or r.to.y)
check("character: teleport keeps the rotation", rawget(bobModel, "_lastKept") == "facing-east")
rawset(bobModel, "GetPivot", nil)
H.env.Vector3 = { new = function(x, y, z) return { __typeName = "Vector3", X = x, Y = y, Z = z } end }
placeCharacter()
rawset(bobRoot, "Position", { X = 0, Y = 10, Z = 0 })

-- walk_to: the mock humanoid finishes the walk when MoveTo is called.
local finishWalk = true
local callback
rawset(bobHumanoid, "MoveToFinished", { Connect = function(self, fn)
    callback = fn
    return { Disconnect = function() end }
end })
rawset(bobHumanoid, "MoveTo", function(self, target)
    rawset(bobRoot, "Position", { X = target.X, Y = target.Y, Z = target.Z })
    if finishWalk then callback(true) end
end)
r = run("character_control.lua", { action = "walk_to", position = { x = 20, y = 10, z = 0 } })
check("character: walk_to reaches the goal", r.reached == true and r.timedOut == false and r.to.x == 20 and r.distanceLeft == 0, r.error or r.reached)
finishWalk = false
rawset(bobHumanoid, "MoveTo", function() end)
r = run("character_control.lua", { action = "walk_to", position = { x = 90, y = 10, z = 0 }, timeout = 1 })
check("character: walk_to times out", r.reached == false and r.timedOut == true and r.distanceLeft > 60, r.error or r.distanceLeft)
rawset(H.nodes.bob, "Character", nil)
r = run("character_control.lua", { action = "teleport", position = { x = 1, y = 1, z = 1 } })
check("character: no character is an error", r.error ~= nil)
rawset(H.nodes.bob, "Character", bobModel)

-- stats ------------------------------------------------------------------------
local frameHandlers = {}
local fakeRunService = { RenderStepped = { Connect = function(self, fn)
    frameHandlers[#frameHandlers + 1] = fn
    return { Disconnect = function() frameHandlers = {} end }
end } }
H.extraServices.RunService = fakeRunService
H.extraServices.Stats = {
    GetTotalMemoryUsageMb = function() return 1234.56 end,
    GetMemoryUsageMbForTag = function() return 10 end,
    DataReceiveKbps = 12.345, DataSendKbps = 1.5, InstanceCount = 5000, PrimitivesCount = 800,
}
local function fakeTask(deltas)
    return { wait = function()
        for _, delta in ipairs(deltas) do
            for _, fn in ipairs(frameHandlers) do fn(delta) end
        end
    end }
end
local smooth = {}
for i = 1, 100 do smooth[i] = 1 / 60 end
r = run("stats.lua", { sample_seconds = 1 }, { task = fakeTask(smooth) })
check("stats: smooth frames", r.frames.count == 100 and r.frames.avgFps == 60 and r.frames.stutters == 0, r.frames.avgFps)
check("stats: memory and world", r.memory.totalMb == 1234.6 and r.world.instances == 5000 and r.world.players == 2, r.memory.totalMb)
check("stats: network leaves out what is missing", r.network.receiveKbps == 12.3 and r.network.pingMs == nil, r.network.receiveKbps)
check("stats: no notes when all is well", #r.notes == 0, #r.notes)
local choppy = {}
for i = 1, 100 do choppy[i] = 1 / 60 end
choppy[50] = 0.2
r = run("stats.lua", {}, { task = fakeTask(choppy) })
check("stats: stutter is reported", r.frames.stutters == 1 and r.frames.worstFrameMs == 200 and r.frames.minFps == 5 and #r.notes >= 1, r.frames.stutters)
check("stats: 1% low uses the slowest frames", r.frames.onePercentLowFps == 5, r.frames.onePercentLowFps)
r = run("stats.lua", { sample_seconds = 99 }, { task = fakeTask({}) })
check("stats: sample clamped and no frames handled", r.sampleSeconds == 5 and r.frames.count == 0 and r.frames.note ~= nil)
r = run("stats.lua", { memory = "detail" }, { task = fakeTask(smooth), Enum = { DeveloperMemoryTag = { GetEnumItems = function() return { { Name = "Gui" }, { Name = "Sounds" } } end } } })
check("stats: memory detail lists categories", r.memory.categories and #r.memory.categories == 2 and r.memory.categories[1].mb == 10)

-- snapshot ---------------------------------------------------------------------
local ws = H.nodes.workspace
r = run("snapshot.lua", { action = "list" })
check("snapshot: list starts empty", r.count == 0)
r = run("snapshot.lua", { action = "diff", name = "x" })
check("snapshot: diff without a snapshot is an error", r.error ~= nil and r.error:find("Take one") ~= nil)
r = run("snapshot.lua", { action = "take", name = "before", path = "game.Workspace.Map", depth = 3 })
check("snapshot: take", r.saved == "before" and r.instances == 3 and r.truncated == false, r.error or r.instances)
r = run("snapshot.lua", { action = "diff", name = "before" })
check("snapshot: unchanged world", r.unchanged == true and r.counts.changed == 0, r.counts and r.counts.changed)

local floor = H.nodes.map:FindFirstChild("Floor")
rawset(floor, "Anchored", false)
rawset(floor, "Size", "10, 2, 10")
new("Part", "Crate", { Anchored = true }, H.nodes.map)
new("Part", "Crate", { Anchored = true }, H.nodes.map)
local wall = H.nodes.map:FindFirstChild("Wall")
table.remove(rawget(H.nodes.map, "_children"), 2)
r = run("snapshot.lua", { action = "diff", name = "before" })
check("snapshot: counts", r.counts.added == 2 and r.counts.removed == 1 and r.counts.changed == 2, r.counts.added .. "/" .. r.counts.removed .. "/" .. r.counts.changed)
check("snapshot: removed path", r.removed[1].path == "Map.Wall", r.removed[1] and r.removed[1].path)
check("snapshot: duplicate names get a number", r.added[1].path == "Map.Crate" and r.added[2].path == "Map.Crate#2", r.added[1] and r.added[1].path)
local seen = {}
for _, change in ipairs(r.changed) do seen[change.property] = change.before .. ">" .. change.after end
check("snapshot: property changes", seen.Anchored == "true>false" and seen.Size == "10, 1, 10>10, 2, 10", seen.Anchored)
r = run("snapshot.lua", { action = "diff", name = "before", limit = 1 })
check("snapshot: lists are cut at the limit", #r.added == 1 and r.counts.added == 2 and r.listsCut == true)
r = run("snapshot.lua", { action = "diff", name = "before", keep = true })
r = run("snapshot.lua", { action = "diff", name = "before" })
check("snapshot: keep replaces the saved state", r.unchanged == true)
r = run("snapshot.lua", { action = "take", name = "tiny", path = "game.Workspace", max_instances = 5, depth = 6 })
check("snapshot: max_instances truncates", r.truncated == true and r.instances == 5 and r.note ~= nil)
r = run("snapshot.lua", { action = "take", name = "props", path = "game.Workspace.Map.Floor", properties = { "Reflectance", "Missing" } })
check("snapshot: custom properties skip missing ones", r.instances == 1)
r = run("snapshot.lua", { action = "list" })
check("snapshot: list shows slots", r.count == 3 and r.snapshots[1].name == "before", r.count)
r = run("snapshot.lua", { action = "take", name = "gone", path = "game.Nope" })
check("snapshot: missing path is an error", r.error ~= nil and r.error:find("Nope") ~= nil)
r = run("snapshot.lua", { action = "delete", name = "tiny" })
check("snapshot: delete", r.deleted == "tiny")
r = run("snapshot.lua", { action = "delete", name = "tiny" })
check("snapshot: delete unknown", r.error ~= nil)
for i = 1, 8 do run("snapshot.lua", { action = "take", name = "slot" .. i, path = "game.Workspace.Map", depth = 1 }) end
r = run("snapshot.lua", { action = "take", name = "overflow", path = "game.Workspace.Map", depth = 1 })
check("snapshot: slot limit", r.error ~= nil and r.error:find("10") ~= nil, r.error)
r = run("snapshot.lua", { action = "take", name = "slot1", path = "game.Workspace.Map", depth = 1 })
check("snapshot: retaking an existing slot is allowed", r.saved == "slot1")
r = run("snapshot.lua", { action = "wat" })
check("snapshot: unknown action", r.error ~= nil)

-- built-in recipes ---------------------------------------------------------------
r = run("recipes/list-remotes.lua", {})
check("recipe list-remotes: finds both remotes", r.total == 2 and r.remotes[1].class ~= nil, r.total)
r = run("recipes/list-remotes.lua", { contains = "BUY" })
check("recipe list-remotes: contains is case-insensitive", r.total == 1 and r.remotes[1].path == "ReplicatedStorage.Buy", r.total)
r = run("recipes/list-remotes.lua", { limit = 1 })
check("recipe list-remotes: limit", r.returned == 1 and r.total == 2)
r = run("recipes/dump-leaderstats.lua", {})
check("recipe dump-leaderstats", r.players == 2 and r.stats[2].values.Coins == 42 and r.stats[1].hasLeaderstats == false, r.players)
r = run("recipes/list-gui-text.lua", { contains = "play" })
check("recipe list-gui-text: filter", r.total == 1 and r.texts[1].text == "Play", r.total)
r = run("recipes/list-gui-text.lua", {})
local allText = true
for _, item in ipairs(r.texts) do if item.text == "" then allText = false end end
check("recipe list-gui-text: skips empty text", r.total >= 2 and allText, r.total)
r = run("recipes/workspace-summary.lua", { top = 3 })
check("recipe workspace-summary", r.totalInstances > 60 and #r.topClasses == 3 and r.topClasses[1].count >= r.topClasses[2].count, r.totalInstances)
new("Sound", "Boom", { SoundId = "rbxassetid://1", Volume = 0.5, Playing = true, Looped = false }, H.nodes.workspace)
new("Sound", "Quiet", { SoundId = "rbxassetid://2", Volume = 1, Playing = false, Looped = true }, H.nodes.workspace)
r = run("recipes/list-sounds.lua", {})
check("recipe list-sounds: all", r.total == 2, r.total)
r = run("recipes/list-sounds.lua", { playing_only = true })
check("recipe list-sounds: playing only", r.total == 1 and r.sounds[1].path == "Workspace.Boom", r.total)

-- built-in recipes: interactables, values, npcs, tools, animations ----------------
local function detach(inst)
    local parent = rawget(inst, "Parent")
    if parent then
        local kids = rawget(parent, "_children")
        for index, child in ipairs(kids) do
            if child == inst then
                table.remove(kids, index)
                break
            end
        end
    end
end
local bobCharacterBefore = rawget(H.nodes.bob, "Character")

local doorPrompt = H.nodes.workspace:FindFirstChild("Door"):FindFirstChild("Prompt")
rawset(doorPrompt, "ActionText", "Open")
rawset(doorPrompt, "ObjectText", "Door")
rawset(doorPrompt, "HoldDuration", 0.5)
rawset(doorPrompt, "MaxActivationDistance", 10)
rawset(doorPrompt, "Enabled", true)
rawset(doorPrompt, "KeyboardKeyCode", "Enum.KeyCode.E")
r = run("recipes/list-interactables.lua", {})
check("recipe list-interactables: prompts and click detectors", r.total == 2 and r.returned == 2, r.total)
r = run("recipes/list-interactables.lua", { kind = "prompt" })
check("recipe list-interactables: prompt details", r.total == 1 and r.interactables[1].actionText == "Open" and r.interactables[1].holdDuration == 0.5 and r.interactables[1].key == "Enum.KeyCode.E" and r.interactables[1].maxDistance == 10, r.total)
r = run("recipes/list-interactables.lua", { kind = "click" })
check("recipe list-interactables: click only", r.total == 1 and r.interactables[1].class == "ClickDetector" and r.interactables[1].actionText == nil, r.total)
r = run("recipes/list-interactables.lua", { contains = "DOOR" })
check("recipe list-interactables: contains is case-insensitive", r.total == 1 and r.interactables[1].path == "Workspace.Door.Prompt", r.total)
r = run("recipes/list-interactables.lua", { kind = "nonsense", limit = 1 })
check("recipe list-interactables: unknown kind means all, limit works", r.total == 2 and r.returned == 1, r.total)

local stats = new("Folder", "Stats", {}, H.nodes.workspace)
new("IntValue", "Level", { Value = 5 }, stats)
new("StringValue", "Title", { Value = "Rookie" }, stats)
new("ObjectValue", "Target", { Value = H.nodes.map }, stats)
new("BoolValue", "Empty", {}, stats)
r = run("recipes/list-values.lua", { path = "Workspace.Stats" })
check("recipe list-values: finds every value object", r.total == 4 and r.returned == 4, r.total)
local byName = {}
for _, item in ipairs(r.values or {}) do byName[item.path:match("[^%.]+$")] = item end
check("recipe list-values: values are shown", byName.Level.value == 5 and byName.Title.value == "Rookie" and byName.Target.value == "Workspace.Map" and byName.Empty.value == nil, r.total)
r = run("recipes/list-values.lua", { path = "game.Workspace.Stats", contains = "LEV" })
check("recipe list-values: a path with game and contains", r.total == 1 and r.values[1].class == "IntValue", r.total)
r = run("recipes/list-values.lua", { path = "Workspace.Nope" })
check("recipe list-values: missing path is an error", r.error ~= nil and r.error:find("Nope") ~= nil, r.error)
r = run("recipes/list-values.lua", { limit = 2 })
check("recipe list-values: whole game and limit", r.total >= 4 and r.returned == 2, r.total)
detach(stats)

local myModel = new("Model", "BobChar", {}, H.nodes.workspace)
new("Part", "HumanoidRootPart", { Position = { X = 0, Y = 0, Z = 0 } }, myModel)
new("Humanoid", "Humanoid", { Health = 100, MaxHealth = 100 }, myModel)
rawset(H.nodes.bob, "Character", myModel)
local guard = new("Model", "Guard", {}, H.nodes.workspace)
new("Part", "HumanoidRootPart", { Position = { X = 3, Y = 4, Z = 0 } }, guard)
new("Humanoid", "Humanoid", { Health = 80, MaxHealth = 100 }, guard)
local faraway = new("Model", "FarAway", {}, H.nodes.workspace)
new("Part", "HumanoidRootPart", { Position = { X = 30, Y = 0, Z = 40 } }, faraway)
new("Humanoid", "Humanoid", { Health = 10, MaxHealth = 50 }, faraway)
r = run("recipes/list-npcs.lua", {})
check("recipe list-npcs: skips player characters, nearest first", r.total == 2 and r.npcs[1].name == "Guard" and r.npcs[2].name == "FarAway", r.total)
check("recipe list-npcs: distance and health", r.npcs[1].distance == 5 and r.npcs[2].distance == 50 and r.npcs[1].health == 80 and r.npcs[2].maxHealth == 50 and r.npcs[1].position.y == 4)
r = run("recipes/list-npcs.lua", { contains = "FAR" })
check("recipe list-npcs: contains is case-insensitive", r.total == 1 and r.npcs[1].name == "FarAway", r.total)
r = run("recipes/list-npcs.lua", { limit = 1 })
check("recipe list-npcs: limit", r.total == 2 and r.returned == 1)

local backpack = new("Backpack", "Backpack", {}, H.nodes.bob)
new("Tool", "Sword", { CanBeDropped = true, RequiresHandle = false, ToolTip = "Slash" }, backpack)
new("Tool", "Torch", { CanBeDropped = false, RequiresHandle = true, ToolTip = "" }, myModel)
new("Tool", "Lost", {}, H.nodes.workspace)
local starterPack = new("Folder", "StarterPack", {})
new("Tool", "Starter", {}, starterPack)
H.extraServices.StarterPack = starterPack
r = run("recipes/list-tools.lua", {})
local where = {}
for _, item in ipairs(r.tools or {}) do where[item.name] = item.where end
check("recipe list-tools: every place is searched once", r.total == 4 and where.Sword == "backpack" and where.Torch == "equipped" and where.Starter == "starterPack" and where.Lost == "workspace", r.total)
check("recipe list-tools: details", r.tools[1].name == "Sword" and r.tools[1].canBeDropped == true and r.tools[1].toolTip == "Slash" and r.tools[2].toolTip == nil)
r = run("recipes/list-tools.lua", { contains = "SW" })
check("recipe list-tools: contains is case-insensitive", r.total == 1 and r.tools[1].name == "Sword", r.total)
r = run("recipes/list-tools.lua", { limit = 1 })
check("recipe list-tools: limit", r.total == 4 and r.returned == 1)
H.extraServices.StarterPack = nil
detach(backpack)

local animator = new("Animator", "Animator", {}, myModel:FindFirstChild("Humanoid"))
rawset(animator, "GetPlayingAnimationTracks", function()
    return { { Name = "Run", Animation = { AnimationId = "rbxassetid://123" }, Priority = "Enum.AnimationPriority.Movement", Length = 1.234, Speed = 1, WeightCurrent = 1, TimePosition = 0.5, Looped = true } }
end)
r = run("recipes/playing-animations.lua", {})
check("recipe playing-animations: lists the tracks", r.count == 1 and r.player == "Bob" and r.tracks[1].name == "Run" and r.tracks[1].animationId == "rbxassetid://123" and r.tracks[1].priority == "Enum.AnimationPriority.Movement" and r.tracks[1].length == 1.23 and r.tracks[1].looped == true, r.error)
r = run("recipes/playing-animations.lua", { player = "Bob" })
check("recipe playing-animations: a player by name", r.count == 1)
r = run("recipes/playing-animations.lua", { player = "Nobody" })
check("recipe playing-animations: unknown player is an error", r.error ~= nil and r.error:find("Nobody") ~= nil, r.error)
detach(animator)
r = run("recipes/playing-animations.lua", {})
check("recipe playing-animations: no Animator is an error", r.error ~= nil and r.error:find("Animator") ~= nil, r.error)
rawset(H.nodes.bob, "Character", nil)
r = run("recipes/playing-animations.lua", {})
check("recipe playing-animations: no character is an error", r.error ~= nil and r.error:find("no character") ~= nil, r.error)
rawset(H.nodes.bob, "Character", bobCharacterBefore)
detach(myModel)
detach(guard)
detach(faraway)
detach(H.nodes.workspace:FindFirstChild("Lost"))

-- built-in recipe: executor-functions -----------------------------------------------
H.genv.myHelper = function() end
H.genv.zetaFn = function() end
H.genv.Toolkit = { alpha = 1, beta = 2, gamma = function() end }
H.genv.IsLoaded = true
H.genv.RetryCount = 3
H.genv.script_key = "abc-secret-123"
H.genv.__SuperbaseInternal = { hidden = true }
r = run("recipes/executor-functions.lua", {})
local function has(list, name)
    for _, item in ipairs(list) do
        if item == name or (type(item) == "table" and item.name == name) then return item end
    end
    return nil
end
local sortedNames = true
for index = 2, #r.functions do
    if r.functions[index - 1] > r.functions[index] then sortedNames = false end
end
check("recipe executor-functions: functions are listed by name, sorted", has(r.functions, "myHelper") ~= nil and has(r.functions, "zetaFn") ~= nil and sortedNames, #r.functions)
local toolkit = has(r.tables, "Toolkit")
check("recipe executor-functions: tables show their member names", toolkit ~= nil and toolkit.entries == 3 and toolkit.members[1] == "alpha" and toolkit.members[3] == "gamma", toolkit and toolkit.entries)
check("recipe executor-functions: booleans and numbers show the value", has(r.values, "IsLoaded").value == true and has(r.values, "RetryCount").value == 3)
local secret = has(r.values, "script_key")
local leaked = false
for field, value in pairs(secret or {}) do
    if type(value) == "string" and value:find("secret", 1, true) then leaked = true end
end
check("recipe executor-functions: a string is never shown, only its length", secret ~= nil and secret.length == 14 and secret.value == nil and not leaked)
check("recipe executor-functions: Superbase's own entries are left out", has(r.tables, "__SuperbaseInternal") == nil and has(r.functions, "__SuperbaseInternal") == nil)
check("recipe executor-functions: counts and total", r.total == 6 and r.counts["function"] == 2 and r.counts.table >= 1 and r.returned == r.total, r.total)
r = run("recipes/executor-functions.lua", { contains = "HELP" })
check("recipe executor-functions: contains is case-insensitive", r.total == 1 and r.functions[1] == "myHelper" and #r.tables == 0, r.total)
r = run("recipes/executor-functions.lua", { type = "table" })
check("recipe executor-functions: type filter", #r.functions == 0 and #r.values == 0 and has(r.tables, "Toolkit") ~= nil)
r = run("recipes/executor-functions.lua", { members = false, contains = "toolkit" })
check("recipe executor-functions: members false", r.tables[1].entries == 3 and r.tables[1].members == nil)
r = run("recipes/executor-functions.lua", { limit = 2 })
check("recipe executor-functions: limit", r.returned == 2 and r.total == 6 and #r.functions + #r.tables + #r.values == 2)
for _, key in ipairs({ "myHelper", "zetaFn", "Toolkit", "IsLoaded", "RetryCount", "script_key", "__SuperbaseInternal" }) do H.genv[key] = nil end

-- dump_scripts ---------------------------------------------------------------
H.genv.__SuperbaseSources = nil
r = run("dump_scripts.lua", {}, { decompile = function(inst) return rawget(inst, "Source") end })
check("dump: pages cover the scripts sorted by path", r.total == 3 and r.nextOffset == nil and #r.scripts == 3 and r.scripts[1].path < r.scripts[2].path and r.scripts[2].path < r.scripts[3].path, r.total)
check("dump: source and class are included", r.scripts[1].source ~= nil and r.scripts[1].className ~= nil and r.placeId ~= nil)
H.genv.__SuperbaseSources = nil
r = run("dump_scripts.lua", { page_chars = 5000 }, { decompile = function() return string.rep("x", 4000) end })
check("dump: a page stops at the character budget and names the next offset", #r.scripts == 2 and r.nextOffset == 2, #r.scripts)
H.genv.__SuperbaseSources = nil
local cut = run("dump_scripts.lua", { max_script_chars = 500 }, { decompile = function() return string.rep("x", 4000) end })
check("dump: long scripts are cut and marked", #cut.scripts[1].source == 500 and cut.scripts[1].truncated == true)
H.genv.__SuperbaseSources = nil
local last = run("dump_scripts.lua", { offset = r.nextOffset }, { decompile = function() return "print(1)" end })
check("dump: the next page continues where the last one stopped", #last.scripts == 1 and last.nextOffset == nil and last.offset == 2, #last.scripts)
H.genv.__SuperbaseSources = nil
r = run("dump_scripts.lua", { class_name = "ModuleScript" }, { decompile = function(inst) return rawget(inst, "Source") end })
check("dump: class filter", r.total == 1 and r.scripts[1].className == "ModuleScript", r.total)
H.genv.__SuperbaseSources = nil
r = run("dump_scripts.lua", {}, { decompile = function() return "<!DOCTYPE html>error page" end })
check("dump: a decompiler error page is replaced by the stored source", #r.scripts == 3 and not r.scripts[1].source:find("DOCTYPE", 1, true))
r = run("dump_scripts.lua", { root = "game.Nope" }, {})
check("dump: unknown root", r.error ~= nil)


-- decompile cache -------------------------------------------------------------
do
    H.genv.__SuperbaseSources = nil
    local decompiles = 0
    local counting = { decompile = function(inst) decompiles = decompiles + 1 return rawget(inst, "Source") end }
    local first = run("get_script_source.lua", { path = "game.ServerScriptService.Main" }, counting)
    local second = run("get_script_source.lua", { path = "game.ServerScriptService.Main" }, counting)
    check("cache: the first read decompiles, the second does not", decompiles == 1 and first.fromCache == false and second.fromCache == true and second.source == first.source, decompiles)
    local refreshed = run("get_script_source.lua", { path = "game.ServerScriptService.Main", refresh = true }, counting)
    check("cache: refresh decompiles again", decompiles == 2 and refreshed.fromCache == false, decompiles)

    H.genv.__SuperbaseSources = nil
    decompiles = 0
    local searched = run("search_scripts.lua", { query = "coins" }, counting)
    local firstCount = decompiles
    local again = run("search_scripts.lua", { query = "coins" }, counting)
    check("cache: a second search decompiles nothing", firstCount > 0 and decompiles == firstCount and again.fromCache == firstCount - (searched.unreadable or 0) and again.totalMatches == searched.totalMatches, again.fromCache)
    run("search_scripts.lua", { query = "coins", refresh = true }, counting)
    check("cache: search with refresh decompiles all again", decompiles == firstCount * 2, decompiles)

    H.genv.__SuperbaseSources = nil
    decompiles = 0
    run("dump_scripts.lua", {}, counting)
    local dumpCount = decompiles
    local dumpAgain = run("dump_scripts.lua", {}, counting)
    check("cache: dump_scripts shares the cache", decompiles == dumpCount and dumpAgain.fromCache == dumpCount, dumpAgain.fromCache)

    -- Failures are not cached: a decompiler that fails once can succeed later.
    H.genv.__SuperbaseSources = nil
    local calls = 0
    local flaky = { decompile = function(inst) calls = calls + 1 if calls == 1 then return "<!DOCTYPE html>down" end return "print('ok')" end }
    local bad = run("get_script_source.lua", { path = "game.ServerScriptService.Client" }, flaky)
    check("cache: an error page is not cached", bad.method ~= "decompile" or bad.source == nil or bad.source:find("DOCTYPE", 1, true) == nil)
    local good = run("get_script_source.lua", { path = "game.ServerScriptService.Client" }, flaky)
    H.genv.__SuperbaseSources = nil
end

-- roblox/loader.lua ---------------------------------------------------------------
local ran, waits, warnings = {}, 0, {}
local function loaderEnv(extra)
    local env = {
        task = {
            spawn = function(fn) fn() end,
            wait = function() waits = waits + 1 if waits > 20 then error("the loader never stopped retrying") end end,
        },
        warn = function(text) warnings[#warnings + 1] = text end,
        loadstring = function(source) return function() ran[#ran + 1] = source end end,
    }
    for k, v in pairs(extra or {}) do env[k] = v end
    return env
end
local function resetLoader()
    ran, waits, warnings = {}, 0, {}
    H.genv.__SuperbaseLoaderRunning = nil
end

resetLoader()
rawset(H.game, "HttpGet", function(self, url) ran[#ran + 1] = "GET " .. url return "client-source" end)
run("roblox/loader.lua", {}, loaderEnv())
check("loader: HttpGet is tried first and its source is run", ran[1] == "GET http://127.0.0.1:9731/client.lua" and ran[2] == "client-source", ran[1])
check("loader: the running flag is cleared when done", H.genv.__SuperbaseLoaderRunning == nil)

resetLoader()
rawset(H.game, "HttpGet", function() error("HttpGet is blocked") end)
run("roblox/loader.lua", {}, loaderEnv({ request = function(options)
    ran[#ran + 1] = options.Method .. " " .. options.Url
    return { StatusCode = 200, Body = "from-request" }
end }))
check("loader: request is used when HttpGet is blocked", ran[1] == "GET http://127.0.0.1:9731/client.lua" and ran[2] == "from-request", ran[2])

resetLoader()
run("roblox/loader.lua", {}, loaderEnv({
    request = function() error("first one is broken") end,
    http_request = function() return { Status = 200, body = "from-second" } end,
}))
check("loader: the next request function is tried and Status/body spellings work", ran[1] == "from-second", ran[1])

resetLoader()
local tries = 0
run("roblox/loader.lua", {}, loaderEnv({ request = function()
    tries = tries + 1
    if tries < 3 then return { StatusCode = 502, Body = "" } end
    return { StatusCode = 200, Body = "finally" }
end }))
check("loader: retries until the bridge answers", ran[1] == "finally" and waits == 2, waits)
check("loader: the same problem is reported once", #warnings == 1 and warnings[1]:find("status 502") ~= nil, #warnings)

resetLoader()
run("roblox/loader.lua", {}, loaderEnv({ syn = { request = function() return { StatusCode = 200, Body = "syn" } end } }))
check("loader: syn.request works", ran[1] == "syn")

resetLoader()
local okStuck = pcall(run, "roblox/loader.lua", {}, loaderEnv({ loadstring = false }))
check("loader: without loadstring it warns and keeps waiting", okStuck == false and warnings[1] and warnings[1]:find("no loadstring") ~= nil, warnings[1])

resetLoader()
H.genv.__SuperbaseLoaderRunning = true
run("roblox/loader.lua", {}, loaderEnv())
check("loader: a second copy does not start another loop", #ran == 0)
resetLoader()
rawset(H.game, "HttpGet", nil)


-- roblox/client.lua: polling transport ------------------------------------------------
do
    local f = assert(io.open("roblox/client.lua", "r"))
    local source = f:read("*a")
    f:close()
    local section = source:match("%-%- BEGIN POLLING TRANSPORT(.-)%-%- END POLLING TRANSPORT")
    check("polling: the section is found in client.lua", section ~= nil)
    local factory = assert(load(section .. "\nreturn createPollingApi", "=polling", "t", setmetatable({}, { __index = _G })))()

    -- A small scheduler: spawn starts a coroutine, step resumes whatever is waiting.
    local tasks = {}
    local function spawn(fn, ...)
        local co = coroutine.create(fn)
        tasks[#tasks + 1] = co
        assert(coroutine.resume(co, ...))
    end
    local function step()
        for _, co in ipairs({ table.unpack(tasks) }) do
            if coroutine.status(co) == "suspended" then assert(coroutine.resume(co)) end
        end
    end
    local function json(value) return value end -- the fake request works on tables directly

    local log, serverQueue, script = {}, {}, {}
    local function fakeRequest(options)
        local path = options.Url:match("^https?://127%.0%.0%.1:9731(.*)$")
        local entry = { url = options.Url, method = options.Method, path = path, headers = options.Headers, body = options.Body }
        log[#log + 1] = entry
        if path:find("^/poll/next") and coroutine.isyieldable() then coroutine.yield() end
        local handler = script[path:match("^[^?]+")]
        if type(handler) == "function" then return handler(entry) end
        return { StatusCode = 200, Body = "{}" }
    end
    local function make(overrides)
        local deps = {
            request = fakeRequest, spawn = spawn, wait = function() if coroutine.isyieldable() then coroutine.yield() end end, waitMs = 10000,
            encode = function(value) return "ENC:" .. tostring(#(value.messages or {})) .. ":" .. tostring(value.userName or "") end,
            decode = function(text)
                if text == "HELLO" then return { type = "hello", token = "tok", userName = "Bob" } end
                if text == "BADHELLO" then return "nope" end
                local list = text:match("^MSGS:(.*)$")
                if list then
                    local out = { messages = {} }
                    for item in list:gmatch("[^,]+") do if item == "CLOSED" then out.closed = true else out.messages[#out.messages + 1] = item end end
                    return out
                end
                if text:find("^SESSION") then return { session = "s1" } end
                if text == "{}" then return {} end
                error("cannot decode " .. text)
            end,
        }
        for k, v in pairs(overrides or {}) do deps[k] = v end
        return factory(deps)
    end
    local function reset()
        tasks, log, serverQueue, script = {}, {}, {}, {}
    end

    -- connect: reachability is any HTTP answer, a thrown request means the bridge is not there.
    reset()
    local api = make()
    local socket = api.connect("ws://127.0.0.1:9731", "")
    check("polling: connect probes /status over http with the client header", log[1].method == "GET" and log[1].path == "/status" and log[1].headers["x-superbase-client"] == "roblox", log[1].path)
    check("polling: no token header when the token is empty", log[1].headers["x-bridge-token"] == nil)
    check("polling: socket looks like a WebSocket", type(socket.Send) == "function" and type(socket.Close) == "function" and socket.OnMessage.Connect ~= nil and socket.OnClose.Connect ~= nil)
    reset()
    script["/status"] = function() return { StatusCode = 401, Body = "{}" } end
    check("polling: a 401 still means the bridge is there", pcall(make().connect, "ws://127.0.0.1:9731", ""))
    reset()
    local deadApi = make({ request = function() error("connection refused") end })
    local okDead, errDead = pcall(deadApi.connect, "ws://127.0.0.1:9731", "")
    check("polling: an unreachable bridge raises the reason", okDead == false and tostring(errDead):find("connection refused", 1, true) ~= nil, errDead)

    reset()
    make().connect("ws://127.0.0.1:9731/", "")
    check("polling: ws becomes http and a trailing slash goes", log[1].url == "http://127.0.0.1:9731/status", log[1].url)
    reset()
    make().connect("wss://127.0.0.1:9731", "")
    check("polling: wss becomes https", log[1].url == "https://127.0.0.1:9731/status", log[1].url)

    -- A full session: hello, welcome through the poll, messages out, close.
    reset()
    script["/poll/hello"] = function() return { StatusCode = 200, Body = "SESSION" } end
    script["/poll/next"] = function() local body = serverQueue[1] and table.remove(serverQueue, 1) or "MSGS:" return { StatusCode = 200, Body = body } end
    script["/poll/send"] = function() return { StatusCode = 200, Body = "{}" } end
    socket = make().connect("wss://127.0.0.1:9731", "tok")
    check("polling: the token travels in a header", log[1].headers["x-bridge-token"] == "tok")
    local received, closedFired = {}, 0
    socket.OnMessage:Connect(function(text) received[#received + 1] = text end)
    socket.OnClose:Connect(function() closedFired = closedFired + 1 end)
    serverQueue[1] = "MSGS:welcome-text,second"
    socket:Send("HELLO")
    local hello
    for _, entry in ipairs(log) do if entry.path == "/poll/hello" then hello = entry end end
    check("polling: the hello opens the session", hello ~= nil and hello.method == "POST" and hello.headers["x-bridge-token"] == "tok", hello and hello.path)
    check("polling: the token is taken out of the hello body", hello and hello.body == "ENC:0:Bob")
    local poll
    for _, entry in ipairs(log) do if entry.path:find("^/poll/next") then poll = entry end end
    check("polling: the poll names the session and the wait", poll and poll.path == "/poll/next?session=s1&wait=10000", poll and poll.path)
    step()
    check("polling: messages from the bridge reach OnMessage in order", received[1] == "welcome-text" and received[2] == "second", table.concat(received, "|"))

    -- Sending: queued messages go out in one batch per flush.
    socket:Send("a")
    socket:Send("b")
    local sends = 0
    for _, entry in ipairs(log) do if entry.path == "/poll/send?session=s1" then sends = sends + 1 end end
    check("polling: sends go to /poll/send with the session", sends >= 1, sends)

    -- Closing by the bridge ends the loops and fires OnClose once.
    serverQueue[1] = "MSGS:CLOSED"
    step()
    step()
    check("polling: closed:true from the bridge fires OnClose once", closedFired == 1, closedFired)
    check("polling: sending on a closed socket raises", pcall(socket.Send, socket, "late") == false)

    -- An unknown session (404) closes too.
    reset()
    script["/poll/hello"] = function() return { StatusCode = 200, Body = "SESSION" } end
    script["/poll/next"] = function() return { StatusCode = 404, Body = "{}" } end
    socket = make().connect("ws://127.0.0.1:9731", "")
    closedFired = 0
    socket.OnClose:Connect(function() closedFired = closedFired + 1 end)
    socket:Send("HELLO")
    step()
    check("polling: a 404 on the poll closes the socket", closedFired == 1, closedFired)

    -- A refused hello closes the socket.
    reset()
    script["/poll/hello"] = function() return { StatusCode = 401, Body = "{}" } end
    socket = make().connect("ws://127.0.0.1:9731", "")
    closedFired = 0
    socket.OnClose:Connect(function() closedFired = closedFired + 1 end)
    socket:Send("HELLO")
    check("polling: a 401 on the hello closes the socket", closedFired == 1, closedFired)
    local pollsAfterRefusal = 0
    for _, entry in ipairs(log) do if entry.path:find("^/poll/next") then pollsAfterRefusal = pollsAfterRefusal + 1 end end
    check("polling: no polling starts after a refused hello", pollsAfterRefusal == 0)

    reset()
    socket = make().connect("ws://127.0.0.1:9731", "")
    closedFired = 0
    socket.OnClose:Connect(function() closedFired = closedFired + 1 end)
    socket:Send("BADHELLO")
    check("polling: an unreadable hello closes the socket", closedFired == 1, closedFired)

    -- Repeated failures close the socket, a single one does not.
    reset()
    local failing = 0
    script["/poll/hello"] = function() return { StatusCode = 200, Body = "SESSION" } end
    script["/poll/next"] = function() failing = failing + 1 if failing <= 2 then error("timeout") end return { StatusCode = 200, Body = "MSGS:hi" } end
    socket = make().connect("ws://127.0.0.1:9731", "")
    received, closedFired = {}, 0
    socket.OnMessage:Connect(function(text) received[#received + 1] = text end)
    socket.OnClose:Connect(function() closedFired = closedFired + 1 end)
    socket:Send("HELLO")
    for _ = 1, 6 do step() end
    check("polling: two failed polls are survived", received[1] == "hi" and closedFired == 0, closedFired)
    reset()
    script["/poll/hello"] = function() return { StatusCode = 200, Body = "SESSION" } end
    script["/poll/next"] = function() error("down") end
    socket = make().connect("ws://127.0.0.1:9731", "")
    closedFired = 0
    socket.OnClose:Connect(function() closedFired = closedFired + 1 end)
    socket:Send("HELLO")
    for _ = 1, 12 do step() end
    check("polling: three failed polls in a row close the socket", closedFired == 1, closedFired)

    -- Close() tells the bridge and stops everything.
    reset()
    script["/poll/hello"] = function() return { StatusCode = 200, Body = "SESSION" } end
    socket = make().connect("ws://127.0.0.1:9731", "")
    socket:Send("HELLO")
    socket:Close()
    socket:Close()
    local closes = 0
    for _, entry in ipairs(log) do if entry.path == "/poll/close?session=s1" then closes = closes + 1 end end
    check("polling: Close posts /poll/close once", closes == 1, closes)
end

-- roblox/client.lua: intro gate ----------------------------------------------------------
do
    local f = assert(io.open("roblox/client.lua", "r"))
    local source = f:read("*a")
    f:close()
    local section = source:match("%-%- BEGIN INTRO GATE(.-)%-%- END INTRO GATE")
    check("intro gate: the section is found in client.lua", section ~= nil)
    local make = assert(load(section .. "\nreturn createIntroGate", "=intro", "t", setmetatable({}, { __index = _G })))()

    local files, memory = {}, {}
    local deps = {
        memory = memory,
        isfile = function(name) return files[name] == true end,
        writefile = function(name) files[name] = true end,
    }
    local gate = make(deps)
    check("intro gate: the first time it plays", gate.shouldPlay({ Enabled = true, Once = true }, false) == true)
    gate.markPlayed()
    check("intro gate: the marker file is written", files["superbase-intro-seen.txt"] == true)
    check("intro gate: it does not play again with Once", gate.shouldPlay({ Enabled = true, Once = true }, false) == false)
    check("intro gate: without Once it always plays", gate.shouldPlay({ Enabled = true, Once = false }, false) == true)
    check("intro gate: Enabled false never plays", gate.shouldPlay({ Enabled = false, Once = false }, false) == false)
    check("intro gate: it is skipped after a teleport", make({ memory = {}, isfile = deps.isfile, writefile = deps.writefile }).shouldPlay({ Enabled = true, Once = false }, true) == false)

    -- A new executor session still has the marker file.
    local fresh = make({ memory = {}, isfile = deps.isfile, writefile = deps.writefile })
    check("intro gate: the file remembers it across sessions", fresh.shouldPlay({ Enabled = true, Once = true }, false) == false)

    -- Deleting the file shows the intro again.
    files = {}
    deps.isfile = function(name) return files[name] == true end
    deps.writefile = function(name) files[name] = true end
    local again = make({ memory = {}, isfile = deps.isfile, writefile = deps.writefile })
    check("intro gate: deleting the file brings the intro back", again.shouldPlay({ Enabled = true, Once = true }, false) == true)

    -- Without file functions it plays once per session, through the shared memory.
    local mem = {}
    local noFiles = make({ memory = mem })
    check("intro gate: no file functions, first time plays", noFiles.shouldPlay({ Enabled = true, Once = true }, false) == true)
    noFiles.markPlayed()
    check("intro gate: no file functions, the memory keeps it for the session", make({ memory = mem }).shouldPlay({ Enabled = true, Once = true }, false) == false)

    -- File functions that raise are survived.
    local broken = make({ memory = {}, isfile = function() error("nope") end, writefile = function() error("nope") end })
    check("intro gate: broken file functions do not stop the intro", broken.shouldPlay({ Enabled = true, Once = true }, false) == true and pcall(broken.markPlayed))
    check("intro gate: the setting exists", source:find("Once = true,", 1, true) ~= nil)
end

-- roblox/client.lua: transport choice and settings ---------------------------------------
do
    local f = assert(io.open("roblox/client.lua", "r"))
    local source = f:read("*a")
    f:close()
    check("client: Transport and PollWait are settings", source:find('Transport = "auto"', 1, true) ~= nil and source:find("PollWait = 10", 1, true) ~= nil)
    check("client: no early return for a missing WebSocket", source:find('does not expose WebSocket.connect', 1, true) == nil)
    check("client: the request functions are looked up", source:find("fluxus and fluxus.request", 1, true) ~= nil and source:find("syn and syn.request", 1, true) ~= nil)
end

-- inspect_code ----------------------------------------------------------------
do
    local fakeClosure = function() end
    local fnNames = {}
    local inspectEnv = {
        getscriptclosure = function(inst) return fakeClosure end,
        getupvalues = function(fn) return { [1] = 5, [2] = "text", [3] = H.nodes.buy, [4] = { a = 1 } } end,
        getconstants = function(fn) return { [1] = "print", [2] = 42 } end,
    }
    r = run("inspect_code.lua", { action = "upvalues", path = "game.ServerScriptService.Main" }, inspectEnv)
    check("inspect: upvalues listed with their types", r.total == 4 and r.values[1].value == "5" and r.values[2].value == '"text"' and r.values[3].type == "Instance" and r.values[3].value:find("ReplicatedStorage.Buy", 1, true) ~= nil, r.error)
    r = run("inspect_code.lua", { action = "upvalues", path = "game.ServerScriptService.Main", limit = 2 }, inspectEnv)
    check("inspect: the limit truncates", r.returned == 2 and r.truncated == true)
    r = run("inspect_code.lua", { action = "constants", path = "game.ServerScriptService.Main" }, inspectEnv)
    check("inspect: constants", r.total == 2 and r.values[1].value == '"print"' and r.values[2].value == "42", r.error)
    r = run("inspect_code.lua", { action = "upvalues", path = "game.Workspace.Map" }, inspectEnv)
    check("inspect: a non-script is refused", r.error ~= nil and r.error:find("not a script", 1, true) ~= nil, r.error)
    r = run("inspect_code.lua", { action = "upvalues", path = "game.Nope" }, inspectEnv)
    check("inspect: a missing path is named", r.error ~= nil and r.error:find("Nope", 1, true) ~= nil)
    r = run("inspect_code.lua", { action = "upvalues", path = "game.ServerScriptService.Main" }, {})
    check("inspect: no getscriptclosure is explained", r.error ~= nil and r.error:find("getscriptclosure", 1, true) ~= nil, r.error)
    local moduleEnv = {
        require = function(inst) return { addCoins = function() end, count = 3 } end,
        getupvalues = inspectEnv.getupvalues,
    }
    r = run("inspect_code.lua", { action = "upvalues", path = "game.ReplicatedStorage.Utils", function_name = "addCoins" }, moduleEnv)
    check("inspect: a function of a module", r.target == "ReplicatedStorage.Utils.addCoins" and r.total == 4, r.error)
    r = run("inspect_code.lua", { action = "upvalues", path = "game.ReplicatedStorage.Utils", function_name = "count" }, moduleEnv)
    check("inspect: a module member that is no function", r.error ~= nil and r.error:find("no function", 1, true) ~= nil, r.error)
    r = run("inspect_code.lua", { action = "upvalues", path = "game.ServerScriptService.Main", function_name = "x" }, inspectEnv)
    check("inspect: function_name needs a ModuleScript", r.error ~= nil and r.error:find("ModuleScript", 1, true) ~= nil, r.error)

    -- gc
    local buyFn, otherFn, ownFn = function() end, function() end, function() end
    fnNames[buyFn], fnNames[otherFn], fnNames[ownFn] = "buyItem", "render", "buyHook"
    local constantsOf = { [buyFn] = { "Buy", "Coins" }, [otherFn] = { "Draw" }, [ownFn] = { "Buy" } }
    local heapTable = { coins = 10, gems = 2 }
    local gcEnv = {
        getgc = function() return { buyFn, otherFn, ownFn, heapTable, { other = 1 }, "text", 7 } end,
        debug = { info = function(fn, what) return "=source", 12, fnNames[fn] end },
        getconstants = function(fn) return constantsOf[fn] or {} end,
        isexecutorclosure = function(fn) return fn == ownFn end,
    }
    r = run("inspect_code.lua", { action = "gc" }, gcEnv)
    check("inspect gc: a filter is required", r.error ~= nil and r.error:find("filter", 1, true) ~= nil, r.error)
    r = run("inspect_code.lua", { action = "gc", name_contains = "BUY" }, gcEnv)
    check("inspect gc: name filter skips executor closures", r.matched == 1 and r.results[1].name == "buyItem" and r.results[1].line == 12, r.matched)
    r = run("inspect_code.lua", { action = "gc", has_constant = "Coins" }, gcEnv)
    check("inspect gc: constant filter", r.matched == 1 and r.results[1].name == "buyItem", r.matched)
    r = run("inspect_code.lua", { action = "gc", name_contains = "buy", has_constant = "Draw" }, gcEnv)
    check("inspect gc: filters combine", r.matched == 0)
    r = run("inspect_code.lua", { action = "gc", kind = "table", has_key = "coins" }, gcEnv)
    check("inspect gc: tables by key", r.matched == 1 and r.results[1].keys[1] ~= nil, r.error)
    r = run("inspect_code.lua", { action = "gc", kind = "table", name_contains = "x" }, gcEnv)
    check("inspect gc: tables need has_key", r.error ~= nil and r.error:find("has_key", 1, true) ~= nil, r.error)
    r = run("inspect_code.lua", { action = "gc", name_contains = "a" }, {})
    check("inspect gc: no getgc is explained", r.error ~= nil and r.error:find("getgc", 1, true) ~= nil, r.error)

    -- connections
    local handler = function() end
    fnNames[handler] = "onClick"
    rawset(H.nodes.play, "MouseButton1Click", { connections = { { Enabled = true, ForeignState = false, Function = handler }, { Enabled = false, ForeignState = false } } })
    r = run("inspect_code.lua", { action = "connections", path = "game.Players.Bob.PlayerGui.Main.Menu.Play", signal = "MouseButton1Click" }, gcEnv)
    check("inspect connections: handlers described", r.total == 2 and r.connections[1].enabled == true and r.connections[1]["function"].name == "onClick" and r.connections[2].enabled == false, r.error)
    r = run("inspect_code.lua", { action = "connections", path = "game.Players.Bob.PlayerGui.Main.Menu.Play", signal = "Nope" }, gcEnv)
    check("inspect connections: unknown signal", r.error ~= nil and r.error:find("no signal", 1, true) ~= nil, r.error)
    r = run("inspect_code.lua", { action = "connections", path = "game.Players.Bob.PlayerGui.Main.Menu.Play" }, gcEnv)
    check("inspect connections: signal required", r.error ~= nil)
    r = run("inspect_code.lua", { action = "nope" }, gcEnv)
    check("inspect: unknown action", r.error ~= nil and r.error:find("Unknown action", 1, true) ~= nil)
end

-- call_instance ----------------------------------------------------------------
do
    local got
    local callEnv = {
        Vector2 = { new = function(x, y) return { __typeName = "Vector2", X = x, Y = y } end },
        Color3 = { fromRGB = function(r2, g, b) return { __typeName = "Color3", R = r2, G = g, B = b } end },
        Enum = { Material = { Neon = "ENUM_NEON" } },
        firesignal = function(signal, ...) got = { signal = signal, args = table.pack(...) } end,
    }
    r = run("call_instance.lua", { action = "method", path = "game.Workspace.Coins", method = "FindFirstChild", args = { "Coin3" } }, callEnv)
    check("call: a method returns its results", r.resultCount == 1 and r.results[1] == "Instance<Part>(Workspace.Coins.Coin3)", r.error)
    r = run("call_instance.lua", { action = "method", path = "game.Workspace.Coins", method = "Nope" }, callEnv)
    check("call: an unknown method is named", r.error ~= nil and r.error:find("no method named Nope", 1, true) ~= nil, r.error)
    r = run("call_instance.lua", { action = "method", path = "game.Workspace.Coins", method = "IsA", args = { "Folder" } }, callEnv)
    check("call: booleans are rendered", r.results[1] == "true", r.error)
    r = run("call_instance.lua", { action = "method", path = "game.Missing", method = "IsA" }, callEnv)
    check("call: a missing path is named", r.error ~= nil and r.error:find("Missing", 1, true) ~= nil)

    rawset(H.nodes.buy, "FireServer", function(self, ...) got = table.pack(...) end)
    r = run("call_instance.lua", { action = "fire_remote", path = "game.ReplicatedStorage.Buy", args = {
        "sword", 3,
        { __type = "Vector3", x = 1, y = 2, z = 3 },
        { __type = "Color3", r = 255, g = 0, b = 10 },
        { __type = "Enum", value = "Enum.Material.Neon" },
        { __type = "Instance", path = "game.Workspace.Map" },
        { nested = { __type = "Vector2", x = 4, y = 5 } },
    } }, callEnv)
    check("call: FireServer is called with converted arguments", r.call == "FireServer" and got.n == 7 and got[1] == "sword" and got[3].__typeName == "Vector3" and got[3].Z == 3 and got[4].R == 255 and got[5] == "ENUM_NEON" and got[6] == H.nodes.map and got[7].nested.Y == 5, r.error)
    rawset(H.nodes.getData, "InvokeServer", function(self, key) return "data:" .. key, 9 end)
    r = run("call_instance.lua", { action = "fire_remote", path = "game.ReplicatedStorage.GetData", args = { "k" } }, callEnv)
    check("call: InvokeServer returns the answer", r.call == "InvokeServer" and r.resultCount == 2 and r.results[1] == '"data:k"' and r.results[2] == "9", r.error)
    r = run("call_instance.lua", { action = "fire_remote", path = "game.Workspace.Map" }, callEnv)
    check("call: fire_remote refuses other classes", r.error ~= nil and r.error:find("not a RemoteEvent", 1, true) ~= nil, r.error)
    r = run("call_instance.lua", { action = "fire_remote", path = "game.ReplicatedStorage.Buy", args = { { __type = "Teapot" } } }, callEnv)
    check("call: an unknown value type is reported with its position", r.error ~= nil and r.error:find("Argument 1", 1, true) ~= nil and r.error:find("Teapot", 1, true) ~= nil, r.error)
    r = run("call_instance.lua", { action = "fire_remote", path = "game.ReplicatedStorage.Buy", args = { { __type = "Enum", value = "Material.Neon" } } }, callEnv)
    check("call: a malformed enum string is reported", r.error ~= nil and r.error:find("Enum.Material.Neon", 1, true) ~= nil, r.error)

    rawset(H.nodes.play, "MouseButton1Click", { name = "signal" })
    r = run("call_instance.lua", { action = "fire_signal", path = "game.Players.Bob.PlayerGui.Main.Menu.Play", signal = "MouseButton1Click", args = { 1 } }, callEnv)
    check("call: firesignal gets the signal and arguments", r.fired == true and got.signal.name == "signal" and got.args[1] == 1, r.error)
    r = run("call_instance.lua", { action = "fire_signal", path = "game.Players.Bob.PlayerGui.Main.Menu.Play", signal = "Nope" }, callEnv)
    check("call: unknown signal", r.error ~= nil and r.error:find("no signal", 1, true) ~= nil, r.error)
    callEnv.firesignal = nil
    r = run("call_instance.lua", { action = "fire_signal", path = "game.Players.Bob.PlayerGui.Main.Menu.Play", signal = "MouseButton1Click" }, callEnv)
    check("call: no firesignal is explained", r.error ~= nil and r.error:find("firesignal", 1, true) ~= nil, r.error)
    r = run("call_instance.lua", { action = "nope", path = "game" }, callEnv)
    check("call: unknown action", r.error ~= nil and r.error:find("Unknown action", 1, true) ~= nil)
end

-- wait_for_instance ------------------------------------------------------------
do
    local clock, created = 0, false
    local waitEnv = {
        os = { clock = function() return clock end, time = os.time },
        task = { wait = function(seconds)
            clock = clock + (seconds or 0.25)
            if clock >= 1 and not created then
                created = true
                H.new("Part", "Late", {}, H.nodes.workspace)
            end
        end },
    }
    r = run("wait_for_instance.lua", { path = "game.Workspace.Map" }, waitEnv)
    check("wait: an existing instance returns at once", r.found == true and r.waitedSeconds == 0 and r.className == "Model", r.error)
    clock = 0
    r = run("wait_for_instance.lua", { path = "game.Workspace.Late", timeout = 5 }, waitEnv)
    check("wait: an instance that appears later is found", r.found == true and r.waitedSeconds >= 1 and r.waitedSeconds < 5, r.waitedSeconds)
    clock = 0
    r = run("wait_for_instance.lua", { path = "game.Workspace.Never.Deeper", timeout = 2 }, waitEnv)
    check("wait: a timeout names the missing segment", r.found == false and r.stillMissing == "Never" and r.waitedSeconds >= 2, r.stillMissing)
    clock = 0
    r = run("wait_for_instance.lua", { path = "game.Workspace.Map", class_name = "Part", timeout = 1 }, waitEnv)
    check("wait: the class must match", r.found == false and r.stillMissing:find("not a Part", 1, true) ~= nil, r.stillMissing)
    r = run("wait_for_instance.lua", { path = "" }, waitEnv)
    check("wait: empty path", r.error ~= nil)
end

-- notify ------------------------------------------------------------------------
do
    H.genv.__Superbase = nil
    r = run("notify.lua", { title = "Hi" })
    check("notify: an old client is explained", r.error ~= nil and r.error:find("too old", 1, true) ~= nil, r.error)
    local shown
    H.genv.__Superbase = { Notify = function(title, text, kind) shown = { title, text, kind }; return true end }
    r = run("notify.lua", { title = "Done", text = "The farm is ready", kind = "success" })
    check("notify: the client shows the toast", r.shown == true and shown[1] == "Done" and shown[2] == "The farm is ready" and shown[3] == "success", r.error)
    H.genv.__Superbase = { Notify = function() return false end }
    r = run("notify.lua", { title = "x" })
    check("notify: switched off notifications are reported", r.shown == false and r.note ~= nil)
    H.genv.__Superbase = { Notify = function() error("boom") end }
    r = run("notify.lua", { title = "x" })
    check("notify: a failing client is reported", r.error ~= nil and r.error:find("boom", 1, true) ~= nil, r.error)
    H.genv.__Superbase = nil
end

-- http_spy ----------------------------------------------------------------------
do
    H.genv.__SuperbaseHttpSpy = nil
    H.genv.__Superbase = nil
    local replacements = {}
    local fakeRequest = function() end
    local httpEnv = {
        request = fakeRequest,
        http_request = fakeRequest,
        hookfunction = function(fn, replacement)
            replacements[#replacements + 1] = replacement
            return function(options)
                if options.Url:find("boom", 1, true) then error("network down", 0) end
                return { StatusCode = 200, Headers = { ["Set-Cookie"] = "a=b", ["Content-Type"] = "text/plain" }, Body = "answer for " .. options.Url }
            end
        end,
        newcclosure = function(fn) return fn end,
    }
    r = run("http_spy.lua", { action = "start", max_body = 30 }, httpEnv)
    check("http spy: start hooks the request function once", r.active == true and #replacements == 1 and r.hooked[1] == "request", r.error)
    local response = replacements[1]({ Url = "https://api.example.com/buy?item=1&token=abc&Key=zzz", Method = "post", Headers = { Authorization = "Bearer x", ["Content-Type"] = "application/json" }, Body = '{"a":1}' })
    check("http spy: the real answer is passed through", response.StatusCode == 200 and response.Body:find("answer for", 1, true) == 1)
    r = run("http_spy.lua", { action = "get" }, httpEnv)
    local call = r.calls and r.calls[1]
    check("http spy: the request is recorded", r.matched == 1 and call.method == "POST" and call.status == 200 and call.source == "request" and call.requestBody == '{"a":1}', r.error)
    check("http spy: query tokens and keys are redacted", call.url == "https://api.example.com/buy?item=1&token=<redacted>&Key=<redacted>", call.url)
    check("http spy: sensitive headers are redacted, others kept", call.requestHeaders.Authorization == "<redacted>" and call.requestHeaders["Content-Type"] == "application/json" and call.responseHeaders["Set-Cookie"] == "<redacted>", call.requestHeaders.Authorization)
    check("http spy: long bodies are cut with their size", call.responseBody:find("characters)", 1, true) ~= nil and #call.responseBody < 80, call.responseBody)

    replacements[1]({ Url = "https://x.test/cookie", Body = "c=_|WARNING:-DO-NOT-SHARE-THIS.--secret123&d=1" })
    r = run("http_spy.lua", { action = "get", url_contains = "x.test" }, httpEnv)
    check("http spy: the Roblox account cookie never gets stored", r.matched == 1 and r.calls[1].requestBody:find("secret123", 1, true) == nil and r.calls[1].requestBody:find("<redacted>", 1, true) ~= nil, r.calls and r.calls[1].requestBody)

    -- Bridge traffic is skipped.
    local before = run("http_spy.lua", { action = "status" }, httpEnv).lastId
    H.genv.__Superbase = { Url = "ws://127.0.0.1:9731" }
    replacements[1]({ Url = "http://127.0.0.1:9731/poll/next?session=1&wait=10" })
    H.genv.__Superbase = nil
    replacements[1]({ Url = "http://127.0.0.1:9731/poll/send?session=1" })
    replacements[1]({ Url = "http://localhost:9731/client.lua?token=t" })
    check("http spy: the client's own bridge traffic is not recorded", run("http_spy.lua", { action = "status" }, httpEnv).lastId == before)
    replacements[1]({ Url = "http://127.0.0.1:3000/api" })
    check("http spy: other local addresses are recorded", run("http_spy.lua", { action = "status" }, httpEnv).lastId == before + 1)

    -- A failing request is recorded and still raises.
    local ok = pcall(replacements[1], { Url = "https://boom.test/x" })
    r = run("http_spy.lua", { action = "get", url_contains = "boom" }, httpEnv)
    check("http spy: failures are recorded and re-raised", ok == false and r.matched == 1 and r.calls[1].error:find("network down", 1, true) ~= nil, r.calls and r.calls[1] and r.calls[1].error)

    -- Filters.
    r = run("http_spy.lua", { action = "get", method = "post" }, httpEnv)
    check("http spy: method filter", r.matched == 1, r.matched)
    r = run("http_spy.lua", { action = "get", limit = 1 }, httpEnv)
    check("http spy: limit keeps the newest", r.returned == 1 and r.calls[1].url:find("boom", 1, true) ~= nil and r.matched > 1)
    local lastId = r.lastId
    r = run("http_spy.lua", { action = "get", since_id = lastId }, httpEnv)
    check("http spy: since_id", r.matched == 0)

    run("http_spy.lua", { action = "stop" }, httpEnv)
    replacements[1]({ Url = "https://after-stop.test/" })
    r = run("http_spy.lua", { action = "get", url_contains = "after-stop" }, httpEnv)
    check("http spy: nothing is recorded after stop", r.matched == 0 and r.active == false)
    r = run("http_spy.lua", { action = "clear" }, httpEnv)
    check("http spy: clear", r.buffered == 0)
    r = run("http_spy.lua", { action = "start" }, httpEnv)
    check("http spy: start again does not hook twice", #replacements == 1 and r.active == true)

    -- game:HttpGet and HttpService through __namecall.
    H.genv.__SuperbaseHttpSpy = nil
    local handler, method
    local namecallEnv = {
        hookmetamethod = function(target, name, fn) handler = fn; return function(self, ...) return "page", select("#", ...) end end,
        getnamecallmethod = function() return method end,
        setnamecallmethod = function(m) method = m end,
        newcclosure = function(fn) return fn end,
        getcallingscript = function() return H.nodes.play end,
    }
    r = run("http_spy.lua", { action = "start" }, namecallEnv)
    check("http spy: namecall hook is enough when there is no request function", r.active == true and r.hooked[1]:find("namecalls", 1, true) ~= nil, r.error)
    method = "HttpGet"
    local body = handler(H.game, "https://pastebin.test/raw/abc?key=1")
    method = "PostAsync"
    handler(H.game, "https://hook.test/in", "payload", "application/json")
    method = "GetService"
    handler(H.game, "HttpService")
    r = run("http_spy.lua", { action = "get" }, namecallEnv)
    check("http spy: HttpGet is recorded with its answer and caller", body == "page" and r.matched == 2 and r.calls[1].method == "GET" and r.calls[1].responseBody == "page" and r.calls[1].source == "HttpGet" and r.calls[1].caller ~= nil, r.matched)
    check("http spy: HttpGet query keys are redacted", r.calls[1].url == "https://pastebin.test/raw/abc?key=<redacted>", r.calls[1].url)
    check("http spy: PostAsync is a POST with its body", r.calls[2].method == "POST" and r.calls[2].requestBody == "payload", r.calls[2].requestBody)

    H.genv.__SuperbaseHttpSpy = nil
    r = run("http_spy.lua", { action = "start" }, {})
    check("http spy: an executor with no hooks is explained", r.error ~= nil and r.error:find("hooked", 1, true) ~= nil, r.error)
    H.genv.__SuperbaseHttpSpy = nil
end

H.report()
