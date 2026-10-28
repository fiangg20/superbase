-- Used by test/lua-runtime.test.js to find an interpreter that is Lua 5.3 or newer.
if _VERSION < "Lua 5.3" then
    os.exit(3)
end
