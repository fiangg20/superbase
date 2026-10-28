--!nocheck
-- Superbase client for Roblox executors.
-- Connects to the local Superbase bridge over WebSocket, streams console logs and
-- script errors, and answers "exec", "inspect" and "ping" commands from the bridge.
-- Several clients (several Roblox windows) can be connected to the same bridge at once.
-- It also plays a short intro and shows status notifications (connected, disconnected, ...).

local CONFIG = {
    Url = "ws://127.0.0.1:9731",
    Token = "", -- leave empty unless the bridge was started with BRIDGE_TOKEN
    ReconnectDelay = 3,
    MaxMessageLength = 4000,
    MaxTableEntries = 200,
    MaxResultLength = 60000,
    MaxDepth = 6,
    HistoryLines = 100,
    Version = "1.3.0",

    -- Status notifications (small toasts in the top right corner).
    Notifications = true, -- connected, disconnected, bridge not found, rejected
    NotifyActivity = true, -- also show a toast when the AI runs code or inspects something
    ActivityCooldown = 3, -- minimum seconds between two activity toasts
    ToastTime = 4, -- seconds a toast stays on screen
    MaxToasts = 4, -- toasts visible at the same time

    -- Intro animation. Set Enabled to false to skip it.
    Intro = {
        Enabled = true,
        Icon = "rbxassetid://132430598780696",
        Color = Color3.fromRGB(51, 95, 255),
        IconSize = 128,
        LoadTime = 4,
        MaxLoadTime = 12,
        RealLoading = true,
        MaxAssets = 150,
        IntroTime = 3,
        BlurSize = 22,
        ShowLoader = true,
        ShowPercent = false,
        Shadow = true,
        ShadowOpacity = 0.45,
        SwipeAngle = 14.43,
        SwipeTime = 1.2,
        SwipeLeftToRight = true,
    },
}

local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")
local LogService = game:GetService("LogService")
local ScriptContext = game:GetService("ScriptContext")
local TweenService = game:GetService("TweenService")
local ContentProvider = game:GetService("ContentProvider")
local RunService = game:GetService("RunService")
local Lighting = game:GetService("Lighting")
local CoreGui = game:GetService("CoreGui")

-- Stop any previous instance (including the older DebugBridge build) so re-executing
-- the script does not stack connections.
local genv = (getgenv and getgenv()) or _G
for _, key in ipairs({ "__Superbase", "__DebugBridge" }) do
    if genv[key] then
        pcall(genv[key].Stop)
        genv[key] = nil
    end
end

local WebSocketApi = WebSocket or (syn and syn.websocket)
if not WebSocketApi or not WebSocketApi.connect then
    warn("[Superbase] This executor does not expose WebSocket.connect")
    return
end

local running = true
local socket = nil
local authenticated = false
local connections = {}

-- ---------------------------------------------------------------------------
-- UI helpers
-- ---------------------------------------------------------------------------

local SINE = Enum.EasingStyle.Sine
local QUINT = Enum.EasingStyle.Quint
local QUART = Enum.EasingStyle.Quart
local OUT = Enum.EasingDirection.Out
local INOUT = Enum.EasingDirection.InOut

local function tween(object, time, properties, style, direction)
    local created = TweenService:Create(object, TweenInfo.new(time, style or QUINT, direction or OUT), properties)
    created:Play()
    return created
end

-- Puts a ScreenGui somewhere the game cannot easily see or remove it.
local function mount(gui)
    if syn and syn.protect_gui then
        pcall(syn.protect_gui, gui)
    end

    local mounted = false
    if gethui then
        mounted = pcall(function()
            gui.Parent = gethui()
        end)
    end
    if not mounted or not gui.Parent then
        pcall(function()
            gui.Parent = CoreGui
        end)
    end
    if not gui.Parent then
        gui.Parent = Players.LocalPlayer:WaitForChild("PlayerGui")
    end
end

local function clearOld(parent, name)
    local old = parent and parent:FindFirstChild(name)
    if old then
        old:Destroy()
    end
end

local function clearOldEverywhere(name)
    clearOld(CoreGui, name)
    clearOld(Players.LocalPlayer and Players.LocalPlayer:FindFirstChild("PlayerGui"), name)
    if gethui then
        local ok, hui = pcall(gethui)
        if ok then
            clearOld(hui, name)
        end
    end
end

local introActive = false
local introObjects = {}

-- ---------------------------------------------------------------------------
-- Status notifications (toasts)
-- ---------------------------------------------------------------------------

local TOAST_GUI_NAME = "SuperbaseToasts"
local TOAST_WIDTH = 290
local TOAST_COLORS = {
    info = CONFIG.Intro.Color,
    success = Color3.fromRGB(46, 204, 113),
    warning = Color3.fromRGB(241, 196, 15),
    error = Color3.fromRGB(231, 76, 60),
}

local toastGui = nil
local toastList = nil
local toasts = {}
local toastCounter = 0

local function toHex(color)
    return string.format(
        "%02X%02X%02X",
        math.floor(color.R * 255 + 0.5),
        math.floor(color.G * 255 + 0.5),
        math.floor(color.B * 255 + 0.5)
    )
end

local function ensureToastGui()
    if toastGui and toastGui.Parent then
        return
    end

    clearOldEverywhere(TOAST_GUI_NAME)

    toastGui = Instance.new("ScreenGui")
    toastGui.Name = TOAST_GUI_NAME
    toastGui.IgnoreGuiInset = true
    toastGui.ResetOnSpawn = false
    toastGui.DisplayOrder = 2147483646
    toastGui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling

    toastList = Instance.new("Frame")
    toastList.Name = "List"
    toastList.BackgroundTransparency = 1
    toastList.AnchorPoint = Vector2.new(1, 0)
    toastList.Position = UDim2.new(1, -16, 0, 16)
    toastList.Size = UDim2.fromOffset(TOAST_WIDTH, 0)
    toastList.AutomaticSize = Enum.AutomaticSize.Y
    toastList.Parent = toastGui

    local layout = Instance.new("UIListLayout")
    layout.Padding = UDim.new(0, 8)
    layout.SortOrder = Enum.SortOrder.LayoutOrder
    layout.HorizontalAlignment = Enum.HorizontalAlignment.Right
    layout.Parent = toastList

    mount(toastGui)
end

local function dismissToast(entry)
    if entry.dismissed then
        return
    end
    entry.dismissed = true

    for index, item in ipairs(toasts) do
        if item == entry then
            table.remove(toasts, index)
            break
        end
    end

    pcall(function()
        local fade = tween(entry.frame, 0.25, { GroupTransparency = 1 }, SINE, OUT)
        fade.Completed:Connect(function()
            entry.frame:Destroy()
        end)
    end)
end

local function showToast(kind, title, text, key)
    local ok, err = pcall(function()
        ensureToastGui()

        -- A toast with the same key replaces the previous one instead of stacking.
        if key then
            for index = #toasts, 1, -1 do
                if toasts[index].key == key then
                    dismissToast(toasts[index])
                end
            end
        end
        while #toasts >= CONFIG.MaxToasts do
            dismissToast(toasts[1])
        end

        local color = TOAST_COLORS[kind] or TOAST_COLORS.info
        toastCounter += 1

        local frame = Instance.new("CanvasGroup")
        frame.Name = "Toast"
        frame.Size = UDim2.fromOffset(TOAST_WIDTH, 0)
        frame.AutomaticSize = Enum.AutomaticSize.Y
        frame.BackgroundColor3 = Color3.fromRGB(22, 24, 30)
        frame.BorderSizePixel = 0
        frame.GroupTransparency = 1
        frame.LayoutOrder = toastCounter
        frame.Parent = toastList

        local corner = Instance.new("UICorner")
        corner.CornerRadius = UDim.new(0, 10)
        corner.Parent = frame

        local padding = Instance.new("UIPadding")
        padding.PaddingTop = UDim.new(0, 10)
        padding.PaddingBottom = UDim.new(0, 10)
        padding.PaddingLeft = UDim.new(0, 14)
        padding.PaddingRight = UDim.new(0, 14)
        padding.Parent = frame

        local layout = Instance.new("UIListLayout")
        layout.Padding = UDim.new(0, 2)
        layout.SortOrder = Enum.SortOrder.LayoutOrder
        layout.Parent = frame

        local titleLabel = Instance.new("TextLabel")
        titleLabel.LayoutOrder = 1
        titleLabel.BackgroundTransparency = 1
        titleLabel.Size = UDim2.new(1, 0, 0, 0)
        titleLabel.AutomaticSize = Enum.AutomaticSize.Y
        titleLabel.Font = Enum.Font.GothamBold
        titleLabel.TextSize = 14
        titleLabel.TextXAlignment = Enum.TextXAlignment.Left
        titleLabel.TextWrapped = true
        titleLabel.RichText = true
        titleLabel.TextColor3 = Color3.new(1, 1, 1)
        titleLabel.Text = string.format('<font color="#%s">●</font>  %s', toHex(color), title)
        titleLabel.Parent = frame

        if text and text ~= "" then
            local textLabel = Instance.new("TextLabel")
            textLabel.LayoutOrder = 2
            textLabel.BackgroundTransparency = 1
            textLabel.Size = UDim2.new(1, 0, 0, 0)
            textLabel.AutomaticSize = Enum.AutomaticSize.Y
            textLabel.Font = Enum.Font.GothamMedium
            textLabel.TextSize = 12
            textLabel.TextXAlignment = Enum.TextXAlignment.Left
            textLabel.TextWrapped = true
            textLabel.TextColor3 = Color3.fromRGB(170, 176, 190)
            textLabel.Text = text
            textLabel.Parent = frame
        end

        local entry = { frame = frame, key = key, dismissed = false }
        toasts[#toasts + 1] = entry

        tween(frame, 0.3, { GroupTransparency = 0 }, QUINT, OUT)
        task.delay(kind == "error" and CONFIG.ToastTime + 2 or CONFIG.ToastTime, dismissToast, entry)
    end)

    if not ok then
        warn("[Superbase] Could not show a notification: " .. tostring(err))
    end
end

-- Toasts wait for the intro to finish, because the intro covers the whole screen.
local function notify(kind, title, text, key)
    if not CONFIG.Notifications then
        return
    end

    task.spawn(function()
        while introActive and running do
            task.wait(0.2)
        end
        if running then
            showToast(kind, title, text, key)
        end
    end)
end

local lastActivityToast = 0

local function notifyActivity(text)
    if not CONFIG.NotifyActivity or introActive then
        return
    end

    local now = os.clock()
    if now - lastActivityToast < CONFIG.ActivityCooldown then
        return
    end
    lastActivityToast = now
    notify("info", "AI activity", text, "activity")
end

-- ---------------------------------------------------------------------------
-- Intro
-- ---------------------------------------------------------------------------

local function playIntro()
    local INTRO = CONFIG.Intro
    local GUI_NAME = "MinimalIntro"
    local BLUR_NAME = "MinimalIntroBlur"
    local TINT_NAME = "MinimalIntroTint"
    local S = INTRO.IconSize

    local function makeShadow(parent, blurRadius, offsetY, spread)
        if not INTRO.Shadow then
            return nil
        end
        local ok, shadow = pcall(function()
            local created = Instance.new("UIShadow")
            created.Color = Color3.new(0, 0, 0)
            created.BlurRadius = UDim.new(0, blurRadius)
            created.Offset = UDim2.fromOffset(0, offsetY)
            created.Spread = UDim2.fromOffset(spread, spread)
            created.Transparency = 1
            created.ZIndex = -1
            created.Parent = parent
            return created
        end)
        return ok and shadow or nil
    end

    clearOldEverywhere(GUI_NAME)
    clearOld(Lighting, BLUR_NAME)
    clearOld(Lighting, TINT_NAME)

    local blur = Instance.new("BlurEffect")
    blur.Name = BLUR_NAME
    blur.Size = 0
    blur.Parent = Lighting
    introObjects[#introObjects + 1] = blur

    local tint = Instance.new("ColorCorrectionEffect")
    tint.Name = TINT_NAME
    tint.TintColor = Color3.new(1, 1, 1)
    tint.Saturation = 0
    tint.Brightness = 0
    tint.Parent = Lighting
    introObjects[#introObjects + 1] = tint

    local gui = Instance.new("ScreenGui")
    gui.Name = GUI_NAME
    gui.IgnoreGuiInset = true
    gui.ResetOnSpawn = false
    gui.DisplayOrder = 2147483647
    gui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
    introObjects[#introObjects + 1] = gui

    local background = Instance.new("Frame")
    background.Name = "Background"
    background.Size = UDim2.fromScale(1, 1)
    background.BackgroundColor3 = INTRO.Color
    background.BackgroundTransparency = 1
    background.BorderSizePixel = 0
    background.Parent = gui

    local SOFT = 0.35
    local SWEEP = 0.9

    local gradient = Instance.new("UIGradient")
    gradient.Rotation = INTRO.SwipeAngle
    if INTRO.SwipeLeftToRight then
        gradient.Transparency = NumberSequence.new({
            NumberSequenceKeypoint.new(0, 1),
            NumberSequenceKeypoint.new(0.5 - SOFT / 2, 1),
            NumberSequenceKeypoint.new(0.5 + SOFT / 2, 0),
            NumberSequenceKeypoint.new(1, 0),
        })
        gradient.Offset = Vector2.new(-SWEEP, 0)
    else
        gradient.Transparency = NumberSequence.new({
            NumberSequenceKeypoint.new(0, 0),
            NumberSequenceKeypoint.new(0.5 - SOFT / 2, 0),
            NumberSequenceKeypoint.new(0.5 + SOFT / 2, 1),
            NumberSequenceKeypoint.new(1, 1),
        })
        gradient.Offset = Vector2.new(SWEEP, 0)
    end
    gradient.Parent = background

    local icon = Instance.new("ImageLabel")
    icon.Name = "Icon"
    icon.AnchorPoint = Vector2.new(0.5, 0.5)
    icon.Position = UDim2.fromScale(0.5, 0.5)
    icon.Size = UDim2.fromOffset(S * 0.88, S * 0.88)
    icon.BackgroundTransparency = 1
    icon.Image = INTRO.Icon
    icon.ImageTransparency = 1
    icon.ScaleType = Enum.ScaleType.Fit
    icon.Parent = background

    local iconShadow = makeShadow(icon, 28, 6, 0)
    if iconShadow then
        Instance.new("UICorner", icon).CornerRadius = UDim.new(0.25, 0)
    end

    local track = Instance.new("Frame")
    track.Name = "LoaderTrack"
    track.AnchorPoint = Vector2.new(0.5, 0)
    track.Position = UDim2.new(0.5, 0, 0.5, S / 2 + 36)
    track.Size = UDim2.fromOffset(120, 2)
    track.BackgroundColor3 = Color3.new(1, 1, 1)
    track.BackgroundTransparency = 1
    track.BorderSizePixel = 0
    track.Visible = INTRO.ShowLoader
    track.Parent = background
    Instance.new("UICorner", track).CornerRadius = UDim.new(1, 0)
    local trackShadow = makeShadow(track, 10, 2, 0)

    local fill = Instance.new("Frame")
    fill.Name = "LoaderFill"
    fill.Size = UDim2.fromScale(0, 1)
    fill.BackgroundColor3 = Color3.new(1, 1, 1)
    fill.BackgroundTransparency = 1
    fill.BorderSizePixel = 0
    fill.Parent = track
    Instance.new("UICorner", fill).CornerRadius = UDim.new(1, 0)

    local percent = Instance.new("TextLabel")
    percent.Name = "Percent"
    percent.AnchorPoint = Vector2.new(0.5, 0)
    percent.Position = UDim2.new(0.5, 0, 0.5, S / 2 + 48)
    percent.Size = UDim2.fromOffset(120, 14)
    percent.BackgroundTransparency = 1
    percent.Font = Enum.Font.GothamMedium
    percent.TextSize = 11
    percent.TextColor3 = Color3.new(1, 1, 1)
    percent.TextTransparency = 1
    percent.Text = "0%"
    percent.Visible = INTRO.ShowPercent
    percent.Parent = background

    mount(gui)

    pcall(function()
        ContentProvider:PreloadAsync({ icon })
    end)

    local function buildSchedule(total)
        local rng = Random.new()
        local count = rng:NextInteger(9, 13)
        local chunks, gSum, tSum = {}, 0, 0

        for i = 1, count do
            local k = i / count
            local g = rng:NextNumber(0.5, 1.5) * (1.4 - 0.9 * k)
            local d = rng:NextNumber(0.5, 1.5) * (0.6 + 0.9 * k)
            local s = (i < count and rng:NextNumber() < 0.45) and rng:NextNumber(0.15, 0.7) or 0
            chunks[i] = { g = g, d = d, s = s }
            gSum = gSum + g
            tSum = tSum + d + s
        end

        local lead = 0.12 * total
        local scaleT = (total - lead) / tSum
        local segs = {}
        local t, p = lead, 0

        for _, chunk in ipairs(chunks) do
            local d = chunk.d * scaleT
            local gain = chunk.g / gSum
            segs[#segs + 1] = { t0 = t, t1 = t + d, p0 = p, p1 = p + gain }
            t = t + d + chunk.s * scaleT
            p = p + gain
        end
        segs[#segs].p1 = 1

        return function(time)
            if time <= lead then
                return 0
            end
            for _, seg in ipairs(segs) do
                if time < seg.t0 then
                    return seg.p0
                end
                if time < seg.t1 then
                    local a = (time - seg.t0) / (seg.t1 - seg.t0)
                    a = 1 - (1 - a) * (1 - a)
                    return seg.p0 + (seg.p1 - seg.p0) * a
                end
            end
            return 1
        end
    end

    local function startRealLoading()
        if not INTRO.RealLoading then
            return function()
                return 1
            end
        end

        local real = 0
        task.spawn(function()
            pcall(function()
                local started = os.clock()
                while not game:IsLoaded() and os.clock() - started < 6 do
                    task.wait(0.1)
                end
                real = 0.15

                local localPlayer = Players.LocalPlayer
                if localPlayer then
                    local waitStarted = os.clock()
                    while not localPlayer.Character and os.clock() - waitStarted < 2 do
                        task.wait(0.1)
                    end
                end
                real = 0.3

                local list = {}
                for _, descendant in ipairs(game:GetService("Workspace"):GetDescendants()) do
                    if
                        descendant:IsA("Decal")
                        or descendant:IsA("Texture")
                        or descendant:IsA("MeshPart")
                        or descendant:IsA("Sound")
                        or descendant:IsA("ParticleEmitter")
                    then
                        list[#list + 1] = descendant
                        if #list >= INTRO.MaxAssets then
                            break
                        end
                    end
                end
                if #list == 0 then
                    return
                end

                local done = 0
                ContentProvider:PreloadAsync(list, function()
                    done = done + 1
                    real = 0.3 + 0.7 * math.min(done / #list, 1)
                end)
            end)
            real = 1
        end)

        return function()
            return real
        end
    end

    local startClock = os.clock()
    local renderConnection

    local function run()
        renderConnection = RunService.RenderStepped:Connect(function()
            local elapsed = os.clock() - startClock
            icon.Position = UDim2.new(0.5, 0, 0.5, math.sin(elapsed * 1.5) * 3)
            percent.Text = string.format("%d%%", math.floor(fill.Size.X.Scale * 100))
        end)

        local function apply(progress)
            local eased = progress * progress * (3 - 2 * progress)
            fill.Size = UDim2.fromScale(progress, 1)
            tint.TintColor = Color3.new(1, 1, 1):Lerp(INTRO.Color, eased)
            tint.Saturation = -0.15 * eased
            tint.Brightness = 0.08 * eased
            blur.Size = INTRO.BlurSize * eased
            icon.ImageTransparency = 1 - eased
            if iconShadow then
                iconShadow.Transparency = 1 - INTRO.ShadowOpacity * eased
            end
            local size = S * (0.88 + 0.12 * eased)
            icon.Size = UDim2.fromOffset(size, size)
        end
        apply(0)

        tween(track, 0.6, { BackgroundTransparency = 0.85 }, QUINT, OUT)
        if trackShadow then
            tween(trackShadow, 0.6, { Transparency = 1 - INTRO.ShadowOpacity }, QUINT, OUT)
        end
        tween(fill, 0.6, { BackgroundTransparency = 0.05 }, QUINT, OUT)
        tween(percent, 0.6, { TextTransparency = 0.45 }, QUINT, OUT)

        local simulated = buildSchedule(INTRO.LoadTime)
        local readReal = startRealLoading()
        local loadStart = os.clock()
        local progress = 0

        while true do
            local dt = RunService.RenderStepped:Wait()
            if not running then
                return
            end
            local elapsed = os.clock() - loadStart

            local real = (elapsed > INTRO.MaxLoadTime) and 1 or readReal()
            local target = math.min(simulated(elapsed), real)

            progress = progress + (target - progress) * (1 - math.exp(-dt * 7))
            if target >= 1 and 1 - progress < 0.002 then
                progress = 1
            end

            apply(progress)
            if progress >= 1 then
                break
            end
        end

        task.wait(0.15)

        local function dropShadow(shadow)
            if not shadow then
                return
            end
            tween(shadow, 0.5, { Transparency = 1 }, SINE, INOUT).Completed:Connect(function()
                shadow.Enabled = false
            end)
        end
        dropShadow(iconShadow)
        dropShadow(trackShadow)

        tween(track, 0.5, { BackgroundTransparency = 1 }, SINE, INOUT)
        tween(fill, 0.5, { BackgroundTransparency = 1 }, SINE, INOUT)
        tween(percent, 0.5, { TextTransparency = 1 }, SINE, INOUT)
        tween(background, 0.9, { BackgroundTransparency = 0 }, SINE, INOUT)

        tween(icon, INTRO.IntroTime, { Size = UDim2.fromOffset(S * 1.12, S * 1.12) }, QUINT, OUT)

        task.wait(INTRO.IntroTime)

        tween(icon, 0.8, { ImageTransparency = 1, Size = UDim2.fromOffset(S * 1.2, S * 1.2) }, QUINT, OUT)
        local sweepEnd = INTRO.SwipeLeftToRight and SWEEP or -SWEEP
        tween(gradient, INTRO.SwipeTime, { Offset = Vector2.new(sweepEnd, 0) }, QUART, INOUT)
        tween(blur, 1.2, { Size = 0 }, SINE, INOUT)
        tween(tint, 1.3, { TintColor = Color3.new(1, 1, 1), Saturation = 0, Brightness = 0 }, SINE, INOUT).Completed:Wait()
    end

    local ok, err = pcall(run)

    if renderConnection then
        renderConnection:Disconnect()
    end
    gui:Destroy()
    blur:Destroy()
    tint:Destroy()
    if not ok then
        warn("[Superbase] Intro failed: " .. tostring(err))
    end
end

-- Removes everything this instance put on screen.
local function destroyUi()
    introActive = false
    for _, object in ipairs(introObjects) do
        pcall(function()
            object:Destroy()
        end)
    end
    table.clear(introObjects)

    if toastGui then
        pcall(function()
            toastGui:Destroy()
        end)
        toastGui = nil
    end
    table.clear(toasts)
end

-- ---------------------------------------------------------------------------
-- Bridge connection
-- ---------------------------------------------------------------------------

local levelMap = {
    [Enum.MessageType.MessageOutput] = "info",
    [Enum.MessageType.MessageInfo] = "info",
    [Enum.MessageType.MessageWarning] = "warn",
    [Enum.MessageType.MessageError] = "error",
}

local function truncate(text, limit)
    limit = limit or CONFIG.MaxMessageLength
    text = tostring(text)
    if #text > limit then
        return string.sub(text, 1, limit) .. "... [truncated]"
    end
    return text
end

local function send(payload)
    local current = socket
    if not current then
        return false
    end

    local encodedOk, encoded = pcall(HttpService.JSONEncode, HttpService, payload)
    if not encodedOk then
        return false
    end

    local sentOk = pcall(function()
        current:Send(encoded)
    end)
    return sentOk
end

-- Converts any Lua value into something JSONEncode can handle.
local function serialize(value, depth)
    depth = depth or 0
    local kind = typeof(value)

    if kind == "nil" then
        return "<nil>"
    elseif kind == "string" then
        return truncate(value, CONFIG.MaxResultLength)
    elseif kind == "number" then
        if value ~= value or value == math.huge or value == -math.huge then
            return tostring(value)
        end
        return value
    elseif kind == "boolean" then
        return value
    elseif kind == "Instance" then
        local ok, fullName = pcall(function()
            return value:GetFullName()
        end)
        return "<Instance " .. value.ClassName .. ": " .. (ok and fullName or "?") .. ">"
    elseif kind == "table" then
        if depth >= CONFIG.MaxDepth then
            return "<table: max depth reached>"
        end

        local out = {}

        -- Plain arrays stay arrays, so the JSON has [..] instead of {"1": ..}.
        local length = #value
        local total = 0
        for _ in pairs(value) do
            total += 1
        end
        if total == length then
            for index = 1, math.min(length, CONFIG.MaxTableEntries) do
                out[index] = serialize(value[index], depth + 1)
            end
            if length > CONFIG.MaxTableEntries then
                out[#out + 1] = "<truncated>"
            end
            return out
        end

        local count = 0
        for key, item in pairs(value) do
            count += 1
            if count > CONFIG.MaxTableEntries then
                out["<truncated>"] = true
                break
            end
            out[tostring(key)] = serialize(item, depth + 1)
        end
        return out
    end

    return "<" .. kind .. " " .. tostring(value) .. ">"
end

-- Compiles and runs code, returns (ok, results) or (false, errorWithTraceback).
local function runCode(code)
    local compile = loadstring or load
    if not compile then
        return false, "loadstring is not available in this executor"
    end

    local fn, compileError = compile(code, "=Superbase")
    if not fn then
        return false, tostring(compileError)
    end

    local packed = table.pack(xpcall(fn, function(err)
        return debug.traceback(tostring(err), 2)
    end))

    if not packed[1] then
        return false, tostring(packed[2])
    end

    local results = {}
    for i = 2, packed.n do
        results[#results + 1] = serialize(packed[i])
    end
    return true, results
end

-- Resolves a dotted path such as "game.Workspace.Map.Part".
-- Limitation: instance names that contain a dot cannot be addressed.
local function resolvePath(path)
    local segments = string.split(path, ".")
    local startIndex = 1
    if segments[1] == "game" then
        startIndex = 2
    end

    local current = game
    for i = startIndex, #segments do
        local name = segments[i]
        if name ~= "" then
            current = current:FindFirstChild(name)
            if not current then
                return nil, "Not found at segment: " .. name
            end
        end
    end
    return current
end

local DEFAULT_PROPERTIES = { "Name", "ClassName", "Parent" }

local function inspectInstance(path, properties)
    local instance, resolveError = resolvePath(path)
    if not instance then
        return false, resolveError
    end

    local info = {
        path = instance:GetFullName(),
        className = instance.ClassName,
        properties = {},
        children = {},
    }

    if type(properties) ~= "table" or #properties == 0 then
        properties = DEFAULT_PROPERTIES
    end

    for _, propertyName in ipairs(properties) do
        local ok, value = pcall(function()
            return instance[propertyName]
        end)
        if ok then
            info.properties[tostring(propertyName)] = serialize(value, 1)
        else
            info.properties[tostring(propertyName)] = "<error: " .. tostring(value) .. ">"
        end
    end

    for index, child in ipairs(instance:GetChildren()) do
        if index > 100 then
            info.childrenTruncated = true
            break
        end
        info.children[#info.children + 1] = { name = child.Name, className = child.ClassName }
    end

    return true, info
end

local function sendHistory()
    local ok, history = pcall(function()
        return LogService:GetLogHistory()
    end)
    if not ok then
        return
    end

    local first = math.max(1, #history - CONFIG.HistoryLines + 1)
    for i = first, #history do
        local entry = history[i]
        send({
            type = "log",
            level = levelMap[entry.messageType] or "info",
            message = truncate(entry.message),
            history = true,
        })
    end
end

local function reply(id, ok, payload)
    if ok then
        send({ type = "result", id = id, ok = true, value = payload })
    else
        send({ type = "result", id = id, ok = false, error = truncate(payload) })
    end
end

-- "online" after a successful handshake, "offline" after the link was lost or never existed.
-- It decides which toast to show, so a retry loop does not spam the screen.
local linkState = nil
local rejectNotified = false

local function handleMessage(raw)
    local decodedOk, message = pcall(HttpService.JSONDecode, HttpService, raw)
    if not decodedOk or type(message) ~= "table" then
        return
    end

    if message.type == "welcome" then
        authenticated = true
        print("[Superbase] Connected and authenticated")

        if linkState == "offline" then
            notify("success", "Reconnected", "The AI can see this game again.", "link")
        else
            notify("success", "Connected", "The AI can now see and debug this game.", "link")
        end
        linkState = "online"
        rejectNotified = false

        sendHistory()
        return
    end

    if not authenticated then
        return
    end

    if message.type == "ping" then
        send({ type = "pong", id = message.id })
    elseif message.type == "exec" then
        notifyActivity("Running Lua code in this game.")
        local ok, result = runCode(tostring(message.code or ""))
        reply(message.id, ok, result)
    elseif message.type == "inspect" then
        local path = tostring(message.path or "game")
        notifyActivity("Inspecting " .. truncate(path, 60))
        local ok, result = inspectInstance(path, message.properties)
        reply(message.id, ok, result)
    end
end

-- Stream console output.
table.insert(connections, LogService.MessageOut:Connect(function(message, messageType)
    if not authenticated then
        return
    end
    send({
        type = "log",
        level = levelMap[messageType] or "info",
        message = truncate(message),
    })
end))

-- Stream script errors with their stack trace.
table.insert(connections, ScriptContext.Error:Connect(function(message, trace, scriptInstance)
    if not authenticated then
        return
    end
    send({
        type = "error",
        message = truncate(message),
        trace = truncate(trace),
        script = scriptInstance and scriptInstance:GetFullName() or nil,
    })
end))

-- Returns something like "Solara 3.2" when the executor can identify itself.
local function getExecutorName()
    if type(identifyexecutor) ~= "function" then
        return nil
    end

    local ok, name, version = pcall(identifyexecutor)
    if not ok or not name then
        return nil
    end
    if version then
        return tostring(name) .. " " .. tostring(version)
    end
    return tostring(name)
end

local function connectLoop()
    local lastConnectError = nil

    while running do
        local ok, result = pcall(WebSocketApi.connect, CONFIG.Url)
        if ok and result then
            lastConnectError = nil
            local current = result
            socket = current
            authenticated = false
            local closed = false

            current.OnMessage:Connect(function(raw)
                task.spawn(handleMessage, raw)
            end)
            current.OnClose:Connect(function()
                closed = true
            end)

            send({
                type = "hello",
                token = CONFIG.Token ~= "" and CONFIG.Token or nil,
                placeId = game.PlaceId,
                jobId = game.JobId,
                userId = Players.LocalPlayer and Players.LocalPlayer.UserId or nil,
                userName = Players.LocalPlayer and Players.LocalPlayer.Name or nil,
                executor = getExecutorName(),
                clientVersion = CONFIG.Version,
            })

            while running and not closed do
                task.wait(1)
            end

            if running and authenticated then
                linkState = "offline"
                notify("warning", "Disconnected", "Lost the connection to the bridge. Reconnecting...", "link")
            elseif running then
                warn("[Superbase] Connection closed before authentication. If the bridge was started with BRIDGE_TOKEN, set CONFIG.Token to the same value.")
                if not rejectNotified then
                    rejectNotified = true
                    notify(
                        "error",
                        "Bridge closed the connection",
                        "If the bridge was started with BRIDGE_TOKEN, set CONFIG.Token to the same value.",
                        "link"
                    )
                end
            end

            pcall(function()
                current:Close()
            end)
            socket = nil
            authenticated = false
        else
            -- Only warn when the reason changes, so a retry loop does not spam the console.
            local reason = tostring(result)
            if reason ~= lastConnectError then
                lastConnectError = reason
                warn("[Superbase] Cannot connect to " .. CONFIG.Url .. ": " .. reason)
            end

            if linkState ~= "offline" then
                linkState = "offline"
                notify(
                    "warning",
                    "Bridge not found",
                    "Start it with npm start. This script keeps retrying every " .. CONFIG.ReconnectDelay .. " seconds.",
                    "link"
                )
            end
        end

        if running then
            task.wait(CONFIG.ReconnectDelay)
        end
    end
end

local function stop()
    running = false
    for _, connection in ipairs(connections) do
        pcall(function()
            connection:Disconnect()
        end)
    end
    table.clear(connections)

    local current = socket
    if current then
        pcall(function()
            current:Close()
        end)
    end
    socket = nil
    authenticated = false
    destroyUi()
end

genv.__Superbase = { Stop = stop }
print("[Superbase] Started, connecting to " .. CONFIG.Url)

if CONFIG.Intro and CONFIG.Intro.Enabled then
    introActive = true
    task.spawn(function()
        local ok, err = pcall(playIntro)
        introActive = false
        if not ok then
            warn("[Superbase] Intro failed: " .. tostring(err))
            for _, object in ipairs(introObjects) do
                pcall(function()
                    object:Destroy()
                end)
            end
            table.clear(introObjects)
        end
    end)
end

task.spawn(connectLoop)
