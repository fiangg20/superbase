-- Recipe: List remotes
-- Description: Lists every RemoteEvent and RemoteFunction in the game, with its path.
-- Args: contains (string, optional, filter on the path), limit (number, default 100)

local contains = type(args.contains) == "string" and string.lower(args.contains) or nil
local limit = tonumber(args.limit) or 100
local found = {}
local total = 0

for _, instance in ipairs(game:GetDescendants()) do
    if instance:IsA("RemoteEvent") or instance:IsA("RemoteFunction") or instance:IsA("UnreliableRemoteEvent") then
        local path = instance:GetFullName()
        if not contains or string.find(string.lower(path), contains, 1, true) then
            total = total + 1
            if #found < limit then
                found[#found + 1] = { path = path, class = instance.ClassName }
            end
        end
    end
end

return { total = total, returned = #found, remotes = found }
