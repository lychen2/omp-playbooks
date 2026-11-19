// omp runs the extension factory once while installing and rolls the install back when it throws, so this never
// throws for a missing Tern.
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tr } from "../../omomp-shared/i18n";
import { findTern, readPluginManifest, type TernPluginCli, type TernResult } from "../../omomp-shared/tern-plugin";

const TERN_PLUGIN_DIR = resolve(import.meta.dir, "../../tern-plugin");
const TERN_PLUGIN_ID = "omp-playbooks";

export type TernPluginState =
	| { readonly kind: "absent" }
	| { readonly kind: "current"; readonly version: string }
	| { readonly kind: "reloaded"; readonly from: string | null; readonly to: string }
	| { readonly kind: "stale"; readonly loaded: string | null; readonly wanted: string; readonly detail: string };

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

export function ensureTernPlugin(): Promise<TernPluginState> {
	done ??= setup();
	return done;
}
