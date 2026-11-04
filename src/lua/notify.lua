-- Superbase snippet: show a toast in the game window through the Superbase client.
-- The MCP server puts "local args = ..." in front of this file.
-- Arguments: args.title, args.text, args.kind ("info", "success", "warning" or "error", default info)

local genv = (getgenv and getgenv()) or _G
local client = genv.__Superbase
if type(client) ~= "table" or type(client.Notify) ~= "function" then
    return { error = "The running Superbase client is too old for notifications. Load the client again (npm run loader prints the line)." }
end

local ok, shown = pcall(client.Notify, tostring(args.title or "Superbase"), tostring(args.text or ""), args.kind)
if not ok then
    return { error = "Could not show the notification: " .. tostring(shown) }
end

return { shown = shown == true, note = shown == true and nil or "Notifications are switched off in the client settings (Notifications = false)." }
