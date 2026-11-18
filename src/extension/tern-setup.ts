// The Tern side of an `omp plugin install` (contracts.md K6 安装). omp runs the extension
// factory once while installing and rolls the install back when it throws, so this never
// throws for a missing Tern: with no `tern` on PATH it links nothing and the install goes
// through; the next extension load that finds `tern` links the Tern plugin. `tern` itself
// is looked up and driven through the shared `tern plugin` adapter in ../../omomp-shared.
//
// The link points Tern at this package's own `tern-plugin/`. The daemon reloads files
// edited in place, but an upgrade replaces the whole package directory, which leaves the
// daemon on a missing link target or the old script. The daemon reports the version it
// loaded; when that differs from `tern-plugin/plugin.toml` on disk, the daemon reloads
// its plugins. A reload that leaves the versions apart is reported, never thrown:
// the failure may belong to another plugin, and the next extension load compares again.
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tr } from "../../omomp-shared/i18n";
import { findTern, readPluginManifest, type TernPluginCli, type TernResult } from "../../omomp-shared/tern-plugin";

/** The Tern plugin directory shipped inside this package. */
const TERN_PLUGIN_DIR = resolve(import.meta.dir, "../../tern-plugin");
const TERN_PLUGIN_ID = "omp-playbooks";

/** What the Tern side looked like after setup; `current` needs no notice. */
export type TernPluginState =
	| { readonly kind: "absent" }
	| { readonly kind: "current"; readonly version: string }
	| { readonly kind: "reloaded"; readonly from: string | null; readonly to: string }
	| { readonly kind: "stale"; readonly loaded: string | null; readonly wanted: string; readonly detail: string };

/** The value of a successful `tern plugin` call; a failed one throws, as direct calls did. */
function unwrap<T>(result: TernResult<T>): T {
	if (!result.ok)
		throw new Error(
			tr(`tern plugin ${result.error.stage}: ${result.error.message}`, `tern plugin ${result.error.stage}：${result.error.message}`),
		);
	return result.value;
}

async function linkedDir(pluginsDir: string): Promise<string | null> {
	const file = Bun.file(join(pluginsDir, `${TERN_PLUGIN_ID}.path`));
	if (!(await file.exists())) return null;
	return (await file.text()).trim();
}

/**
 * The version of this plugin the running daemon loaded (the plugins directory's when no
 * daemon runs), null when the listing has no entry for it, or the reason it could not be read.
 */
async function loadedVersion(
	cli: TernPluginCli,
): Promise<{ readonly ok: true; readonly version: string | null } | { readonly ok: false; readonly detail: string }> {
	const listed = await cli.list();
	if (!listed.ok)
		return { ok: false, detail: tr(`tern plugin list: ${listed.error.message}`, `tern plugin list：${listed.error.message}`) };
	return { ok: true, version: listed.value.find((plugin) => plugin.id === TERN_PLUGIN_ID)?.version ?? null };
}

async function setup(): Promise<TernPluginState> {
	const found = findTern();
	if (found.kind === "not_installed") return { kind: "absent" };
	const cli = found.cli;
	const wanted = await realpath(TERN_PLUGIN_DIR);
	const pluginsDir = unwrap(await cli.dir());
	if ((await linkedDir(pluginsDir)) !== wanted) unwrap(await cli.link(wanted));

	const manifest = await readPluginManifest(wanted, TERN_PLUGIN_ID);
	if (!manifest.ok) throw new Error(manifest.error.message);
	const version = manifest.value.version;
	if (version === undefined)
		throw new Error(tr(`${join(wanted, "plugin.toml")} has no string version`, `${join(wanted, "plugin.toml")} 没有字符串版本`));

	const before = await loadedVersion(cli);
	if (!before.ok) return { kind: "stale", loaded: null, wanted: version, detail: before.detail };
	if (before.version === version) return { kind: "current", version };

	const reload = await cli.reload(TERN_PLUGIN_ID);
	const after = await loadedVersion(cli);
	if (after.ok && after.version === version) return { kind: "reloaded", from: before.version, to: version };
	const detail = [
		after.ok ? "" : after.detail,
		reload.ok
			? tr("tern plugin reload reported success", "tern plugin reload 报告成功")
			: tr(`tern plugin reload: ${reload.error.message}`, `tern plugin reload：${reload.error.message}`),
	]
		.filter(Boolean)
		.join("\n");
	return { kind: "stale", loaded: after.ok ? after.version : before.version, wanted: version, detail };
}

let done: Promise<TernPluginState> | undefined;

/** Once per process: the factory is rebound for every subagent session. */
export function ensureTernPlugin(): Promise<TernPluginState> {
	done ??= setup();
	return done;
}
