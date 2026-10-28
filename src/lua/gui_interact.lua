-- Superbase snippet: look at and operate the game's GUI.
-- The MCP server puts "local args = ..." in front of this file.
-- Arguments:
--   args.action   "list", "click", "set_text" or "trigger"
--   list:     args.root (dotted path, default the local player's PlayerGui), args.kind ("buttons",
--             "inputs" or "all"), args.visible_only (default true), args.text (text filter), args.limit
--   click:    args.path (a GuiButton), args.mode ("signal" fires the button's own events, "mouse"
--             sends a real click at its center through VirtualInputManager, "auto" is signal first)
--   set_text: args.path (a TextBox), args.text, args.submit (also press Enter)
--   trigger:  args.path (a ClickDetector, a ProximityPrompt, or a part or model that has one)

local Players = game:GetService("Players")
local GuiService = game:GetService("GuiService")

local action = tostring(args.action or "list")

local function resolvePath(path)
    local current = game
    local first = true
    for segment in string.gmatch(path, "[^%.]+") do
        if first and segment == "game" then
            first = false
        else
            first = false
            current = current:FindFirstChild(segment)
            if not current then
                return nil, segment
            end
        end
    end
    return current
end

local function isA(instance, className)
    local ok, result = pcall(function()
        return instance:IsA(className)
    end)
    return ok and result
end

-- A GUI object is only visible when it and every ancestor is switched on.
local function effectivelyVisible(instance)
    local current = instance
    while current and current ~= game do
        if isA(current, "GuiObject") and current.Visible == false then
            return false
        end
        if isA(current, "ScreenGui") and current.Enabled == false then
            return false
        end
        current = current.Parent
    end
    return true
end

local function describe(instance)
    local text = nil
    local okText, value = pcall(function()
        return instance.Text
    end)
    if okText and type(value) == "string" then
        text = #value > 100 and (string.sub(value, 1, 100) .. "...") or value
    end

    return {
        path = instance:GetFullName(),
        className = instance.ClassName,
        text = text,
        visible = effectivelyVisible(instance),
        x = math.floor(instance.AbsolutePosition.X),
        y = math.floor(instance.AbsolutePosition.Y),
        width = math.floor(instance.AbsoluteSize.X),
        height = math.floor(instance.AbsoluteSize.Y),
    }
end

local function requireInstance(path)
    if type(path) ~= "string" or path == "" then
        return nil, "The path is required."
    end
    local instance, missing = resolvePath(path)
    if not instance then
        return nil, "Not found at segment: " .. tostring(missing)
    end
    return instance
end

if action == "list" then
    local root
    if args.root and tostring(args.root) ~= "" then
        local missing
        root, missing = resolvePath(tostring(args.root))
        if not root then
            return { error = "Not found at segment: " .. tostring(missing) }
        end
    else
        local player = Players.LocalPlayer
        root = player and player:FindFirstChildOfClass("PlayerGui")
        if not root then
            return { error = "The local player has no PlayerGui yet." }
        end
    end

    local kind = tostring(args.kind or "all")
    local visibleOnly = args.visible_only ~= false
    local textFilter = args.text and string.lower(tostring(args.text)) or nil
    local limit = math.max(1, math.min(200, math.floor(tonumber(args.limit) or 60)))

    local results = {}
    local total = 0
    local scanned = 0

    for _, instance in ipairs(root:GetDescendants()) do
        scanned = scanned + 1
        if scanned % 3000 == 0 then
            task.wait()
        end

        local wanted = false
        if kind == "buttons" or kind == "all" then
            wanted = isA(instance, "GuiButton")
        end
        if not wanted and (kind == "inputs" or kind == "all") then
            wanted = isA(instance, "TextBox")
        end

        if wanted and (not visibleOnly or effectivelyVisible(instance)) then
            local info = describe(instance)
            if not textFilter or (info.text and string.find(string.lower(info.text), textFilter, 1, true)) or string.find(string.lower(instance.Name), textFilter, 1, true) then
                total = total + 1
                if #results < limit then
                    results[#results + 1] = info
                end
            end
        end
    end

    return {
        root = root:GetFullName(),
        total = total,
        returned = #results,
        truncated = total > #results,
        elements = results,
    }
elseif action == "click" then
    local instance, problem = requireInstance(args.path)
    if not instance then
        return { error = problem }
    end
    if not isA(instance, "GuiButton") then
        return { error = instance:GetFullName() .. " is a " .. instance.ClassName .. ", not a button." }
    end

    local mode = tostring(args.mode or "auto")

    local function clickWithSignals()
        local fired = 0
        local signals = { "Activated", "MouseButton1Click", "MouseButton1Down", "MouseButton1Up" }

        if type(getconnections) == "function" then
            for _, signalName in ipairs(signals) do
                local okList, list = pcall(getconnections, instance[signalName])
                if okList and type(list) == "table" then
                    for _, connection in ipairs(list) do
                        -- Executors differ: some connection objects have Fire, others expose Function.
                        local okFire = pcall(function()
                            connection:Fire()
                        end)
                        if not okFire then
                            okFire = pcall(function()
                                connection.Function()
                            end)
                        end
                        if okFire then
                            fired = fired + 1
                        end
                    end
                end
            end
            return fired > 0, fired
        end

        if type(firesignal) == "function" then
            for _, signalName in ipairs(signals) do
                if pcall(firesignal, instance[signalName]) then
                    fired = fired + 1
                end
            end
            return fired > 0, fired
        end

        return false, 0
    end

    local function clickWithMouse()
        local ok, manager = pcall(function()
            return game:GetService("VirtualInputManager")
        end)
        if not ok or not manager then
            return false, "VirtualInputManager is not available in this executor."
        end
        if not effectivelyVisible(instance) then
            return false, "The button is not visible, a mouse click would miss it."
        end

        -- Absolute positions do not include the top bar inset unless the ScreenGui ignores it.
        local inset = GuiService:GetGuiInset()
        local screenGui = instance:FindFirstAncestorWhichIsA("ScreenGui")
        local offsetX, offsetY = inset.X, inset.Y
        if screenGui and screenGui.IgnoreGuiInset then
            offsetX, offsetY = 0, 0
        end
        local x = instance.AbsolutePosition.X + instance.AbsoluteSize.X / 2 + offsetX
        local y = instance.AbsolutePosition.Y + instance.AbsoluteSize.Y / 2 + offsetY

        local sent = pcall(function()
            manager:SendMouseButtonEvent(x, y, 0, true, game, 1)
            task.wait(0.05)
            manager:SendMouseButtonEvent(x, y, 0, false, game, 1)
        end)
        if not sent then
            return false, "The mouse event could not be sent."
        end
        return true, { x = math.floor(x), y = math.floor(y) }
    end

    if mode == "mouse" then
        local ok, detail = clickWithMouse()
        if not ok then
            return { error = detail }
        end
        return { clicked = instance:GetFullName(), method = "mouse", at = detail }
    end

    local ok, fired = clickWithSignals()
    if ok then
        return { clicked = instance:GetFullName(), method = "signal", connectionsFired = fired }
    end

    if mode == "signal" then
        return { error = "No connections could be fired. This button may not have any, or the executor lacks getconnections and firesignal." }
    end

    local mouseOk, detail = clickWithMouse()
    if not mouseOk then
        return { error = "The button has no connections that could be fired, and the mouse fallback failed: " .. tostring(detail) }
    end
    return { clicked = instance:GetFullName(), method = "mouse", at = detail }
elseif action == "set_text" then
    local instance, problem = requireInstance(args.path)
    if not instance then
        return { error = problem }
    end
    if not isA(instance, "TextBox") then
        return { error = instance:GetFullName() .. " is a " .. instance.ClassName .. ", not a TextBox." }
    end
    if args.text == nil then
        return { error = "The text is required." }
    end

    local text = tostring(args.text)
    local okSet, setError = pcall(function()
        instance.Text = text
    end)
    if not okSet then
        return { error = "Could not set the text: " .. tostring(setError) }
    end

    local submitted = false
    if args.submit == true then
        local focused = pcall(function()
            instance:CaptureFocus()
        end)
        task.wait(0.05)
        local released = pcall(function()
            instance:ReleaseFocus(true)
        end)
        submitted = focused and released

        if not submitted and type(firesignal) == "function" then
            submitted = pcall(firesignal, instance.FocusLost, true, nil)
        end
    end

    return { path = instance:GetFullName(), text = instance.Text, submitted = submitted }
elseif action == "trigger" then
    local instance, problem = requireInstance(args.path)
    if not instance then
        return { error = problem }
    end

    local target = instance
    if not isA(target, "ClickDetector") and not isA(target, "ProximityPrompt") then
        target = nil
        for _, descendant in ipairs(instance:GetDescendants()) do
            if isA(descendant, "ClickDetector") or isA(descendant, "ProximityPrompt") then
                target = descendant
                break
            end
        end
    end
    if not target then
        return { error = instance:GetFullName() .. " is not a ClickDetector or ProximityPrompt and has none inside it." }
    end

    if isA(target, "ClickDetector") then
        if type(fireclickdetector) ~= "function" then
            return { error = "This executor does not provide fireclickdetector." }
        end
        local ok, err = pcall(fireclickdetector, target)
        if not ok then
            return { error = "fireclickdetector failed: " .. tostring(err) }
        end
        return { triggered = target:GetFullName(), className = "ClickDetector" }
    end

    if type(fireproximityprompt) ~= "function" then
        return { error = "This executor does not provide fireproximityprompt." }
    end
    local ok, err = pcall(fireproximityprompt, target)
    if not ok then
        return { error = "fireproximityprompt failed: " .. tostring(err) }
    end
    return { triggered = target:GetFullName(), className = "ProximityPrompt" }
end

return { error = "Unknown action '" .. action .. "'. Use list, click, set_text or trigger." }
