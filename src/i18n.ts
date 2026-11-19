import { LANGUAGE_ENV, language } from "../omomp-shared/i18n";

function shellWord(value: string): string {
	return `'${value.replaceAll("'", () => `'\\''`).replaceAll('"', () => `'$'\\x22''`)}'`;
}

/**
 * The line holds no double quote, which Windows PowerShell 5.1 drops from the arguments of
 * programs it starts.
 */
export function withLanguage(argv: readonly string[]): string[] {
	return ["omp", "bash", "-c", `${LANGUAGE_ENV}=${language()} ${argv.map(shellWord).join(" ")}`];
}
