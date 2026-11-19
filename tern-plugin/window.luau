--!strict

local MAIN = tern.plugin.dir .. "/../src/service/main.ts"
local WINDOWS = string.sub(tern.plugin.dir, 1, 1) ~= "/"

local function chinese(): boolean
	local explicit = tern.getenv("OMOMP_LANG")
	if explicit ~= nil then
		local named = string.lower((string.gsub(explicit, "^%s*(.-)%s*$", "%1")))
		if named == "zh" or named == "en" then
			return named == "zh"
		end
	end
	for _, key in { "LC_ALL", "LC_MESSAGES", "LANG" } do
		local value = tern.getenv(key)
		if value ~= nil and string.match(value, "%S") ~= nil then
			return string.match(string.lower(value), "^%s*zh") ~= nil
		end
	end
	return false
end

local function tr(en: string, zh: string): string
	return if chinese() then zh else en
end

local function quote(text: string): string
	return "'" .. (string.gsub(text, "'", "'\\''")) .. "'"
end

-- Tern windows started from the GUI may not have the user's PATH,
-- so `bun` resolves through the login shell elsewhere, as pane launches do.
local function open_command(path: string, pane: string): { string }
	if WINDOWS then
		return { "bun", MAIN, "--open", path, pane }
	end
	return { tern.getenv("SHELL") or "/bin/zsh", "-lc", "exec bun " .. quote(MAIN) .. " --open " .. quote(path) .. " " .. quote(pane) }
end

local function show(path: string, pane: string)
	tern.process.run(open_command(path, pane), function(result, cx)
		if cx == nil or result.status == 0 then
			return
		end
		cx:toast("error", tr("Playbook cannot be shown", "Playbook 无法显示"), result.stderr)
	end)
end

-- `available` runs under the palette's 4 ms
-- budget, so this stays to table lookups and never reads the file.
local function focused_yaml(cx): string?
	local id = cx.session:focused()
	local pane = if id == nil then nil else cx.session:pane(id)
	if pane == nil or pane.kind ~= "file" or pane.path == nil then
		return nil
	end
	local path = pane.path
	if string.match(path, "%.ya?ml$") == nil then
		return nil
	end
	return path
end

-- Tern's CommandDef.title accepts only a string, so the palette title resolves at registration.
tern.command({
	id = "open",
	title = tr("Playbook: open", "Playbook: 打开"),
	icon = "file",
	available = function(cx)
		return focused_yaml(cx) ~= nil
	end,
	run = function(cx)
		local path = focused_yaml(cx)
		if path == nil then
			return
		end
		local target = cx.session:focused()
		if target == nil then
			cx:toast("error", tr("No focused pane to open the Playbook beside", "没有可以在旁边打开 Playbook 的 pane"))
			return
		end
		if not tern.fs.exists(MAIN) then
			cx:toast("error", tr("The document service entry is missing; reinstall the omp plugin omp-playbooks", "找不到文档服务入口；请重新安装 omp 插件 omp-playbooks"), MAIN)
			return
		end
		show(path, tostring(target))
	end,
})
