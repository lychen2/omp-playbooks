import { describe, expect, test } from "bun:test";
import { language } from "../omomp-shared/i18n";
import { withLanguage } from "../src/i18n";

describe("process language", () => {
	test("withLanguage starts argv unchanged with the language resolved at call time", async () => {
		const previous = process.env.OMOMP_LANG;
		const words = ["a b", "c'd", 'say "hi"', "e$'x", "D:\\x y\\"];
		const probe = [process.execPath, "-e", "console.log(JSON.stringify([process.env.OMOMP_LANG, ...process.argv.slice(1)]))", ...words];
		const run = async (argv: readonly string[]): Promise<unknown> => {
			const [, shell, flag, line] = argv;
			expect(shell).toBe("bash");
			expect(flag).toBe("-c");
			if (line === undefined) throw new Error(`no command line in ${JSON.stringify(argv)}`);
			const child = Bun.spawn(["bash", "-c", line], { env: { ...process.env, OMOMP_LANG: "" }, stderr: "pipe" });
			const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
			if (!out.trim()) throw new Error(`no stdout; stderr=${err.trim()}`);
			return JSON.parse(out);
		};
		try {
			process.env.OMOMP_LANG = "en";
			expect(language()).toBe("en");
			const en = withLanguage(probe);
			expect(en[0]).toBe("omp");
			expect(en.join(" ")).not.toContain('"');
			process.env.OMOMP_LANG = "zh";
			expect(language()).toBe("zh");
			expect(await run(en)).toEqual(["en", ...words]);
			expect(await run(withLanguage(probe))).toEqual(["zh", ...words]);
		} finally {
			if (previous === undefined) delete process.env.OMOMP_LANG;
			else process.env.OMOMP_LANG = previous;
		}
	});
});
