-- Recipe: List sounds
-- Description: Lists the sounds in the game with their id, volume and whether they are playing.
-- Args: playing_only (boolean, default false), limit (number, default 100)

local limit = tonumber(args.limit) or 100
local found = {}
local total = 0

for _, instance in ipairs(game:GetDescendants()) do
    if instance:IsA("Sound") and (args.playing_only ~= true or instance.Playing) then
        total = total + 1
        if #found < limit then
            found[#found + 1] = {
                path = instance:GetFullName(),
                soundId = instance.SoundId,
                volume = instance.Volume,
                playing = instance.Playing,
                looped = instance.Looped,
            }
        end
    end
end

return { total = total, returned = #found, sounds = found }
