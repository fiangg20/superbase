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
H.genv.__SuperbaseSpy = nil
r = run("remote_spy.lua", { action = "start" }, {})
check("spy: reports missing executor APIs", r.error and r.error:find("hookmetamethod") ~= nil, r.error)
r = run("remote_spy.lua", { action = "nope" }, {})
check("spy: unknown action", r.error ~= nil)

H.report()
