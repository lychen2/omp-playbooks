import type { ToolInfo } from "@oh-my-pi/pi-coding-agent";
import { tr } from "../../omomp-shared/i18n";
import type { AgentAnswer } from "../domain/protocol";

export type ToolDescription = Pick<ToolInfo, "name" | "description" | "sourceInfo">;

const HEADING = "# Available Agents";

export function availableAgents(tools: readonly ToolDescription[]): AgentAnswer {
	const task = tools.filter((tool) => tool.name === "task" && tool.sourceInfo.source === "builtin");
	if (task.length !== 1)
		return {
			kind: "unavailable",
			reason: tr(
				"This session has no built-in task tool, so its subagents cannot be listed",
				"本会话没有内置的 task 工具，无法列出 subagent",
			),
		};
	const lines = task[0]!.description.split("\n");
	const start = lines.findIndex((line) => line.trim() === HEADING);
	if (start < 0)
		return {
			kind: "unavailable",
			reason: tr(
				"The omp task tool description has no Available Agents section, so its subagents cannot be listed",
				"omp 的 task 工具说明里没有 Available Agents 一节，无法列出 subagent",
			),
		};
	const names: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (/^#\s/.test(line)) break;
		if (line.trim() === "Agent spawning is currently disabled.")
			return { kind: "unavailable", reason: tr("This session cannot spawn subagents", "本会话禁止启动 subagent") };
		const name = /^- `([^`]+)`/.exec(line)?.[1]?.trim();
		if (name && !names.includes(name)) names.push(name);
	}
	return names.length > 0
		? { kind: "listed", names }
		: { kind: "unavailable", reason: tr("This session has no subagents that can be started", "本会话没有可启动的 subagent") };
}
