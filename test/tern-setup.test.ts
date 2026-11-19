import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";

test("with no tern on PATH, setup reports absent instead of throwing", async () => {
	const emptyPath = await mkdtemp("/tmp/pb-no-tern-");
	try {
		const entry = resolve(import.meta.dir, "../src/extension/tern-setup.ts");
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				`const { ensureTernPlugin } = await import(${JSON.stringify(entry)}); console.log(JSON.stringify(await ensureTernPlugin()));`,
			],
			{
				env: { ...process.env, PATH: emptyPath },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
		expect(JSON.parse(stdout)).toEqual({ kind: "absent" });
	} finally {
		await rm(emptyPath, { recursive: true, force: true });
	}
});
