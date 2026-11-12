--!nocheck
-- Superbase loader. It downloads the Superbase client from your local bridge and runs it.
-- Use it instead of the one line loadstring when the executor blocks game:HttpGet for localhost (it then tries the
-- executor's request function), or put it in your executor's autoexec folder: it waits and retries until the bridge
-- answers, so it also works when the bridge is not running yet when the game starts.
-- "npm run loader" prints this file with the right address, "npm run setup" can write it into an autoexec folder.

local BRIDGE = "127.0.0.1:9731"
local TOKEN = "" -- only for a bridge started with a token, it is added to the address as ?token=
local RETRY_SECONDS = 3
-- "npm run setup" and "npm run autoexec" set this to true in the copy they put in the autoexec folder. The executor then
-- runs the loader again after every teleport, which is how the client comes back. The client only uses this marker for its message.
local AUTOEXEC = false

local environment = _G
if type(getgenv) == "function" then
    local ok, value = pcall(getgenv)
    if ok and type(value) == "table" then
        environment = value
    end
end

-- Running this twice at the same time must not start two download loops.
if environment.__SuperbaseLoaderRunning then
    return
end
environment.__SuperbaseLoaderRunning = true

local function statusOf(response)
    return tonumber(response.StatusCode or response.Status or response.status_code or response.status)
end

local function download(url)
    local ok, body = pcall(function()
        return game:HttpGet(url)
    end)
    if ok and type(body) == "string" and body ~= "" then
        return body
    end

    -- HttpGet is blocked or missing: use whichever request function the executor has.
    local senders = {}
    if type(request) == "function" then
        senders[#senders + 1] = request
    end
    if type(http_request) == "function" then
        senders[#senders + 1] = http_request
    end
    if type(syn) == "table" and type(syn.request) == "function" then
        senders[#senders + 1] = syn.request
    end
    if type(http) == "table" and type(http.request) == "function" then
        senders[#senders + 1] = http.request
    end
    assert(#senders > 0, "This executor has neither a working game:HttpGet nor a request function.")

    local failure = "no request function answered"
    for _, send in ipairs(senders) do
        local sent, response = pcall(send, { Url = url, Method = "GET" })
        if sent and type(response) == "table" then
            if statusOf(response) == 200 then
                local text = response.Body or response.body
                if type(text) == "string" and text ~= "" then
                    return text
                end
            end
            failure = "the bridge answered with status " .. tostring(statusOf(response))
        elseif not sent then
            failure = tostring(response)
        end
    end
    error(failure, 0)
end

local function load()
    assert(type(loadstring) == "function", "This executor has no loadstring.")
    local source = download("http://" .. BRIDGE .. "/client.lua" .. (TOKEN ~= "" and ("?token=" .. TOKEN) or ""))
    local chunk, compileError = loadstring(source)
    assert(chunk, compileError)
    if AUTOEXEC then
        environment.__SuperbaseAutoexec = true
    end
    chunk()
end

task.spawn(function()
    local lastError = nil
    while true do
        local ok, failure = pcall(load)
        if ok then
            break
        end
        -- Say it once, so waiting for the bridge does not fill the console.
        if tostring(failure) ~= lastError then
            lastError = tostring(failure)
            warn("[Superbase loader] " .. lastError .. " (retrying every " .. RETRY_SECONDS .. " seconds)")
        end
        task.wait(RETRY_SECONDS)
    end
    environment.__SuperbaseLoaderRunning = nil
end)
