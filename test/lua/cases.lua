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

-- dump_scripts ---------------------------------------------------------------
r = run("dump_scripts.lua", {}, { decompile = function(inst) return rawget(inst, "Source") end })
check("dump: pages cover the scripts sorted by path", r.total == 3 and r.nextOffset == nil and #r.scripts == 3 and r.scripts[1].path < r.scripts[2].path and r.scripts[2].path < r.scripts[3].path, r.total)
check("dump: source and class are included", r.scripts[1].source ~= nil and r.scripts[1].className ~= nil and r.placeId ~= nil)
r = run("dump_scripts.lua", { page_chars = 5000 }, { decompile = function() return string.rep("x", 4000) end })
check("dump: a page stops at the character budget and names the next offset", #r.scripts == 2 and r.nextOffset == 2, #r.scripts)
local cut = run("dump_scripts.lua", { max_script_chars = 500 }, { decompile = function() return string.rep("x", 4000) end })
check("dump: long scripts are cut and marked", #cut.scripts[1].source == 500 and cut.scripts[1].truncated == true)
local last = run("dump_scripts.lua", { offset = r.nextOffset }, { decompile = function() return "print(1)" end })
check("dump: the next page continues where the last one stopped", #last.scripts == 1 and last.nextOffset == nil and last.offset == 2, #last.scripts)
r = run("dump_scripts.lua", { class_name = "ModuleScript" }, { decompile = function(inst) return rawget(inst, "Source") end })
check("dump: class filter", r.total == 1 and r.scripts[1].className == "ModuleScript", r.total)
r = run("dump_scripts.lua", {}, { decompile = function() return "<!DOCTYPE html>error page" end })
check("dump: a decompiler error page is replaced by the stored source", #r.scripts == 3 and not r.scripts[1].source:find("DOCTYPE", 1, true))
r = run("dump_scripts.lua", { root = "game.Nope" }, {})
check("dump: unknown root", r.error ~= nil)

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

H.report()
