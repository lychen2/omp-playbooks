import { tr } from "../../omomp-shared/i18n";
import { type CompileError, type CompileResult, outlinedText, type Source } from "../domain/model";
import type { ChecksModule } from "../domain/ports";
import { draftDiagnostics } from "./draft/components";
import { outlineProblems } from "./draft/outline";

function unreachable(value: never): never {
	throw new Error(`Unexpected checks variant: ${JSON.stringify(value)}`);
}

function normalizedSource(source: Source) {
	switch (source.kind) {
		case "block":
			return [source.kind, source.target, source.expression];
		case "result":
			return [source.kind, source.target, source.expression, source.seq, source.origin, source.launch];
		case "external":
			return [source.kind, source.target, source.expression, source.fetchedAt];
	}
	return unreachable(source);
}

function normalizedError(error: CompileError) {
	const site = [error.at.block, error.at.reference];
	switch (error.kind) {
		case "UnknownBlock":
		case "NoResult":
			return [error.kind, site, error.block];
		case "UnknownTarget":
		case "TooDeep":
			return [error.kind, site];
		case "BadExpression":
			return [error.kind, site, error.reason];
		case "Cycle":
			return [error.kind, site, error.path];
		case "FetchFailed":
			return [error.kind, site, error.target, error.error];
		case "UnknownSlot":
			return [error.kind, site, error.block, error.slot];
	}
	return unreachable(error);
}

function normalizedCompile(compiled: CompileResult) {
	switch (compiled.kind) {
		case "Ok":
			return [compiled.kind, compiled.text, compiled.sources.map(normalizedSource)];
		case "Err":
			return [compiled.kind, normalizedError(compiled.error)];
	}
	return unreachable(compiled);
}

function questions(): ChecksModule["questions"] {
	return [
		{
			id: "missing",
			type: "bool",
			instructions: tr(
				"`compiled` is the entire prompt a subagent receives; it can see nothing else. Does `compiled` mention material (logs, discussion, files, earlier results) whose content is absent from `compiled`?",
				"`compiled` 是子代理收到的完整提示；它看不到其他内容。`compiled` 是否提到了日志、讨论、文件或早先结果等材料，而这些材料的内容并不在 `compiled` 中？",
			),
			threshold: 0.5,
		},
	];
}

export const checks: ChecksModule = {
	get questions() {
		return questions();
	},
	findings({ compiled, expansions, content, render }) {
		const common = {
			compile: compiled.kind === "Err",
			render_error: render.blockError || render.documentError,
			render_pending: render.pendingOverdue,
		};
		const text = content.kind === "task" ? content.body : content.design;
		const outlined = outlinedText(content);
		return {
			...common,
			empty_expansion: content.kind === "task" && expansions.some((expansion) => expansion.kind === "Ok" && expansion.text.trim() === ""),
			draft: render.draftErrors > 0 || draftDiagnostics(text).some((found) => found.severity === "error"),
			outline: outlined !== null && outlineProblems(outlined).length > 0,
		};
	},
	version({ closure, results, compiled }) {
		const normalized = [
			[...closure].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
			results.map((result) => JSON.stringify([result.text, result.at, result.seq, result.origin, result.launch])).sort(),
			normalizedCompile(compiled),
		];
		return new Bun.CryptoHasher("sha256").update(JSON.stringify(normalized)).digest("hex");
	},
	validateReport(result) {
		switch (result.kind) {
			case "judge_unavailable":
				return true;
			case "answers": {
				const answers = result.answers;
				if (answers === null || typeof answers !== "object" || Array.isArray(answers)) return false;
				const ids = Object.keys(answers);
				const table = questions();
				return (
					ids.length === table.length &&
					table.every((question) => {
						const value = answers[question.id];
						return ids.includes(question.id) && typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
					})
				);
			}
		}
		return unreachable(result);
	},
};
