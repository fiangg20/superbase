-- Recipe: Workspace summary
-- Description: Counts the instances in the workspace by class and shows the biggest top-level containers.
-- Args: top (number, default 15, how many classes and containers to show)

local top = tonumber(args.top) or 15
local byClass, total = {}, 0
for _, instance in ipairs(workspace:GetDescendants()) do
    total = total + 1
    byClass[instance.ClassName] = (byClass[instance.ClassName] or 0) + 1
end

local classes = {}
for name, count in pairs(byClass) do
    classes[#classes + 1] = { class = name, count = count }
end
table.sort(classes, function(a, b)
    return a.count > b.count
end)

local containers = {}
for _, child in ipairs(workspace:GetChildren()) do
    containers[#containers + 1] = { name = child.Name, class = child.ClassName, descendants = #child:GetDescendants() }
end
table.sort(containers, function(a, b)
    return a.descendants > b.descendants
end)

local function cut(list)
    local out = {}
    for index = 1, math.min(#list, top) do
        out[index] = list[index]
    end
    return out
end

return { totalInstances = total, topClasses = cut(classes), biggestContainers = cut(containers) }
