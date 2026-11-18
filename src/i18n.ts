// Person-facing text follows the language of the process at the time it is used; the shared copy in
// ../omomp-shared/i18n resolves it from the environment on every call. Only helpers specific to this
// repository live here.

import { LANGUAGE_ENV, language } from "../omomp-shared/i18n";

/**
 * `value` as one bash word without a double quote character: single-quoted, `'` as `'\''` and `"` as
 * `$'\x22'`. The replacers are functions because `$'` in a replacement string means "text after the match".
 */
function shellWord(value: string): string {
	return `'${value.replaceAll("'", () => `'\\''`).replaceAll('"', () => `'$'\\x22''`)}'`;
}

/**
 * `argv` run with the current process language in a Tern pane that does not inherit this process's
 * environment: omp's own bash runs `argv` with the variable set and exits with its status, on every
 * platform. The line holds no double quote, which Windows PowerShell 5.1 drops from the arguments of
 * programs it starts.
 */
export function withLanguage(argv: readonly string[]): string[] {
	return ["omp", "bash", "-c", `${LANGUAGE_ENV}=${language()} ${argv.map(shellWord).join(" ")}`];
}
