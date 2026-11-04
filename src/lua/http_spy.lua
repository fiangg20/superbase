-- Superbase snippet: record the HTTP requests that scripts send (request functions, game:HttpGet, HttpService).
-- The MCP server puts "local args = ..." in front of this file.
-- Arguments:
--   args.action        "start", "stop", "get", "clear" or "status"
--   start:  args.max_calls (buffer size, default 200), args.max_body (characters kept of each body, default 500, at most 4000),
--           args.include_bodies (default true), args.url_contains (only keep requests whose address contains this)
--   get:    args.since_id, args.url_contains, args.method, args.limit (default 30)
-- It records requests made by the game and by any other script in the executor. The traffic between the Superbase client and
-- its bridge is skipped. Authorization, cookie and token values are replaced with <redacted> before they are stored.
-- The recorder lives in the executor's global table, so it survives running this snippet again.

local action = tostring(args.action or "status")
local genv = (getgenv and getgenv()) or _G

local state = genv.__SuperbaseHttpSpy
if type(state) ~= "table" then
    state = {
        active = false,
        hooks = {},
        namecallHooked = false,
        calls = {},
        nextId = 1,
        dropped = 0,
        maxCalls = 200,
        maxBody = 500,
        includeBodies = true,
        urlContains = nil,
    }
    genv.__SuperbaseHttpSpy = state
end

local function statusInfo()
    local hooked = {}
    for _, name in ipairs(state.hooks) do
        hooked[#hooked + 1] = name
    end
    if state.namecallHooked then
        hooked[#hooked + 1] = "HttpGet/HttpPost/HttpService namecalls"
    end
    return {
        active = state.active,
        hooked = hooked,
        buffered = #state.calls,
        lastId = state.nextId - 1,
        dropped = state.dropped,
        maxCalls = state.maxCalls,
        maxBody = state.maxBody,
        includeBodies = state.includeBodies,
        urlContains = state.urlContains,
    }
end

-- Redaction ----------------------------------------------------------------------------------------------------------

local SENSITIVE_WORDS = { "authorization", "cookie", "token", "secret", "password", "key", "signature", "auth" }

local function sensitiveName(name)
    local lowered = string.lower(tostring(name))
    for _, word in ipairs(SENSITIVE_WORDS) do
        if string.find(lowered, word, 1, true) then
            return true
        end
    end
    return false
end

-- Removes the Roblox account cookie wherever it appears in a text.
local function scrub(text)
    return (string.gsub(text, "_|WARNING:%-DO%-NOT%-SHARE%-THIS[^%s\"';,]*", "<redacted>"))
end

local function redactUrl(url)
    url = scrub(tostring(url))
    return (string.gsub(url, "([?&])([^=&#]+)=([^&#]*)", function(separator, name, value)
        if sensitiveName(name) then
            return separator .. name .. "=<redacted>"
        end
        return nil
    end))
end

local function clip(text)
    text = scrub(tostring(text))
    if #text > state.maxBody then
        return string.sub(text, 1, state.maxBody) .. "... (" .. #text .. " characters)"
    end
    return text
end

local function redactHeaders(headers)
    if type(headers) ~= "table" then
        return nil
    end
    local out = {}
    local count = 0
    for name, value in pairs(headers) do
        count = count + 1
        if count > 30 then
            out["..."] = "more headers"
            break
        end
        out[tostring(name)] = sensitiveName(name) and "<redacted>" or clip(value)
    end
    return out
end

-- The address of the Superbase bridge, so the client's own requests are not recorded.
local function isBridgeTraffic(url)
    local host = string.match(string.lower(url), "^%a+://([^/?#]+)")
    if not host then
        return false
    end
    local client = genv.__Superbase
    if type(client) == "table" and type(client.Url) == "string" then
        local bridgeHost = string.match(string.lower(client.Url), "^%a+://([^/?#]+)")
        if bridgeHost and bridgeHost == host then
            return true
        end
    end
    -- An older client does not publish its address. The bridge on this computer is the fallback.
    local bareHost = string.match(host, "^(.-):%d+$") or host
    local loopback = bareHost == "localhost" or string.find(host, "^127%.") ~= nil or string.find(host, "^%[::1%]") ~= nil
    return loopback and (string.find(url, "/poll/", 1, true) ~= nil or string.find(url, "/client.lua", 1, true) ~= nil)
end

-- Recording ---------------------------------------------------------------------------------------------------------

local function add(entry)
    if state.urlContains and not string.find(string.lower(entry.url), state.urlContains, 1, true) then
        return
    end
    local id = state.nextId
    state.nextId = id + 1
    entry.id = id
    entry.time = os.time() * 1000
    state.calls[#state.calls + 1] = entry
    while #state.calls > state.maxCalls do
        table.remove(state.calls, 1)
        state.dropped = state.dropped + 1
    end
end

local function bodyOf(value)
    if not state.includeBodies or value == nil then
        return nil
    end
    if type(value) == "string" then
        return clip(value)
    end
    return clip(typeof(value))
end

-- A request made with request({ Url = ..., Method = ..., Headers = ..., Body = ... }).
local function recordRequest(source, options, response, failure, seconds)
    if not state.active or type(options) ~= "table" then
        return
    end
    local url = tostring(options.Url or options.url or "")
    if url == "" or isBridgeTraffic(url) then
        return
    end
    local entry = {
        source = source,
        method = string.upper(tostring(options.Method or options.method or "GET")),
        url = redactUrl(url),
        requestHeaders = redactHeaders(options.Headers or options.headers),
        requestBody = bodyOf(options.Body or options.body),
        seconds = seconds,
    }
    if failure then
        entry.error = clip(failure)
    elseif type(response) == "table" then
        entry.status = response.StatusCode or response.Status or response.status_code
        entry.responseHeaders = redactHeaders(response.Headers or response.headers)
        entry.responseBody = bodyOf(response.Body or response.body)
    end
    add(entry)
end

-- A call like game:HttpGet(url) or HttpService:PostAsync(url, data).
local function recordNamecall(method, self, packed, results, failure, seconds)
    if not state.active then
        return
    end
    local first = packed[1]
    local entry = { source = method, seconds = seconds }
    if method == "RequestAsync" then
        if type(first) ~= "table" then
            return
        end
        recordRequest(method, first, type(results) == "table" and results[1] or nil, failure, seconds)
        return
    end
    local url = tostring(first or "")
    if url == "" or isBridgeTraffic(url) then
        return
    end
    entry.url = redactUrl(url)
    entry.method = (method == "HttpPost" or method == "HttpPostAsync" or method == "PostAsync") and "POST" or "GET"
    if entry.method == "POST" then
        entry.requestBody = bodyOf(packed[2])
    end
    if failure then
        entry.error = clip(failure)
    elseif type(results) == "table" then
        entry.responseBody = bodyOf(results[1])
    end
    if type(getcallingscript) == "function" then
        local ok, script = pcall(getcallingscript)
        if ok and typeof(script) == "Instance" then
            local okName, fullName = pcall(function()
                return script:GetFullName()
            end)
            entry.caller = okName and fullName or nil
        end
    end
    add(entry)
end

-- Hooks ---------------------------------------------------------------------------------------------------------------

local function wrapRequest(source, original)
    local handler = function(options, ...)
        local started = os.clock()
        local packed = table.pack(pcall(original, options, ...))
        local seconds = math.floor((os.clock() - started) * 1000) / 1000
        if packed[1] then
            pcall(recordRequest, source, options, packed[2], nil, seconds)
            return table.unpack(packed, 2, packed.n)
        end
        pcall(recordRequest, source, options, nil, packed[2], seconds)
        error(packed[2], 0)
    end
    if type(newcclosure) == "function" then
        handler = newcclosure(handler)
    end
    return handler
end

local function installRequestHooks()
    if type(hookfunction) ~= "function" then
        return false, "This executor has no hookfunction."
    end
    local candidates = {
        { "request", type(request) == "function" and request or nil },
        { "http_request", type(http_request) == "function" and http_request or nil },
        { "syn.request", type(syn) == "table" and type(syn.request) == "function" and syn.request or nil },
        { "http.request", type(http) == "table" and type(http.request) == "function" and http.request or nil },
        { "fluxus.request", type(fluxus) == "table" and type(fluxus.request) == "function" and fluxus.request or nil },
    }
    local seen = {}
    local failures = {}
    for _, candidate in ipairs(candidates) do
        local name, fn = candidate[1], candidate[2]
        if fn and not seen[fn] then
            seen[fn] = true
            local original
            local replacement = wrapRequest(name, function(...)
                return original(...)
            end)
            local ok, result = pcall(hookfunction, fn, replacement)
            if ok and type(result) == "function" then
                original = result
                state.hooks[#state.hooks + 1] = name
            else
                failures[#failures + 1] = name .. ": " .. tostring(result)
            end
        end
    end
    return #state.hooks > 0, failures
end

local NAMECALLS = {
    HttpGet = true, HttpGetAsync = true, HttpPost = true, HttpPostAsync = true,
    GetAsync = true, PostAsync = true, RequestAsync = true,
}

local function installNamecallHook()
    if state.namecallHooked then
        return true
    end
    if type(hookmetamethod) ~= "function" or type(getnamecallmethod) ~= "function" then
        return false
    end
    local original
    local handler = function(self, ...)
        local method = getnamecallmethod()
        if state.active and NAMECALLS[method] and typeof(self) == "Instance" then
            local packed = table.pack(...)
            local started = os.clock()
            if type(setnamecallmethod) == "function" then
                setnamecallmethod(method)
            end
            local results = table.pack(pcall(original, self, ...))
            local seconds = math.floor((os.clock() - started) * 1000) / 1000
            if results[1] then
                pcall(recordNamecall, method, self, packed, table.pack(table.unpack(results, 2, results.n)), nil, seconds)
                return table.unpack(results, 2, results.n)
            end
            pcall(recordNamecall, method, self, packed, nil, results[2], seconds)
            error(results[2], 0)
        end
        return original(self, ...)
    end
    if type(newcclosure) == "function" then
        handler = newcclosure(handler)
    end
    local ok, result = pcall(hookmetamethod, game, "__namecall", handler)
    if not ok then
        return false
    end
    original = result
    state.namecallHooked = true
    return true
end

if action == "start" then
    if #state.hooks == 0 then
        local installed, detail = installRequestHooks()
        local namecall = installNamecallHook()
        if not installed and not namecall then
            local reason = type(detail) == "string" and detail or table.concat(detail or {}, "; ")
            return { error = "No HTTP function could be hooked. " .. reason }
        end
    else
        installNamecallHook()
    end

    state.maxCalls = math.max(20, math.min(1000, math.floor(tonumber(args.max_calls) or 200)))
    state.maxBody = math.max(0, math.min(4000, math.floor(tonumber(args.max_body) or 500)))
    state.includeBodies = args.include_bodies ~= false
    state.urlContains = args.url_contains and string.lower(tostring(args.url_contains)) or nil
    state.active = true
    return statusInfo()
elseif action == "stop" then
    state.active = false
    return statusInfo()
elseif action == "clear" then
    state.calls = {}
    state.dropped = 0
    return statusInfo()
elseif action == "status" then
    return statusInfo()
elseif action == "get" then
    local sinceId = tonumber(args.since_id) or 0
    local limit = math.max(1, math.min(100, math.floor(tonumber(args.limit) or 30)))
    local contains = args.url_contains and string.lower(tostring(args.url_contains)) or nil
    local method = args.method and string.upper(tostring(args.method)) or nil

    local matches = {}
    for _, call in ipairs(state.calls) do
        if call.id > sinceId
            and (not method or call.method == method)
            and (not contains or string.find(string.lower(call.url), contains, 1, true)) then
            matches[#matches + 1] = call
        end
    end

    local calls = {}
    for index = math.max(1, #matches - limit + 1), #matches do
        calls[#calls + 1] = matches[index]
    end

    local info = statusInfo()
    info.matched = #matches
    info.returned = #calls
    info.calls = calls
    return info
end

return { error = "Unknown action '" .. action .. "'. Use start, stop, get, clear or status." }
