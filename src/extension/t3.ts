import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { type BlockId, parseBlockId, parseRunId, type RecordKind } from "../domain/model";
import { documentEndpoint } from "../domain/protocol";
import { checks } from "../service/checks";
import { Core } from "../service/core";
import { fetcher } from "../service/fetch";
import { references } from "../service/references";
import { serveK1 } from "../service/socket";
import { createStore } from "../service/store";

const PROTOCOL = "2025-06-18";

export interface T3Preview {
	open(url: string, tabId?: string): Promise<string | undefined>;
}

export function t3Preview(): T3Preview | null {
	const endpointValue = process.env.T3_MCP_URL;
	const token = process.env.T3_MCP_BEARER_TOKEN;
	if (!endpointValue || !token) return null;
	const endpoint = endpointValue;
	const headers = new Headers({
		accept: "application/json, text/event-stream",
		authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}`,
		"content-type": "application/json",
		"mcp-protocol-version": PROTOCOL,
	});
	let initialized: Promise<unknown> | undefined;

	async function rpc(method: string, params: unknown) {
		const response = await fetch(endpoint, {
			method: "POST",
			headers,
			body: JSON.stringify({ jsonrpc: "2.0", ...(method.startsWith("notifications/") ? {} : { id: randomUUID() }), method, params }),
			signal: AbortSignal.timeout(30_000),
		});
		const session = response.headers.get("mcp-session-id");
		if (session) headers.set("mcp-session-id", session);
		if (!response.ok) throw new Error(`T3 ${method}: HTTP ${response.status}`);
		const raw = await response.text();
		if (raw === "") return undefined;
		const payload = response.headers.get("content-type")?.includes("text/event-stream")
			? raw.split("\n").find((line) => line.startsWith("data:"))?.slice(5)
			: raw;
		if (!payload) throw new Error(`T3 ${method}: empty response`);
		const reply: unknown = JSON.parse(payload);
		if (typeof reply !== "object" || reply === null) throw new Error(`T3 ${method}: invalid response`);
		if ("error" in reply) {
			const error = reply.error;
			throw new Error(error && typeof error === "object" && "message" in error ? String(error.message) : `T3 ${method} failed`);
		}
		return "result" in reply ? reply.result : undefined;
	}

	return {
		async open(url, tabId) {
			initialized ??= rpc("initialize", {
				protocolVersion: PROTOCOL,
				capabilities: {},
				clientInfo: { name: "omp-playbooks", version: "0.1.53" },
			})
				.then(() => rpc("notifications/initialized", {}))
				.catch((error) => {
					initialized = undefined;
					headers.delete("mcp-session-id");
					throw error;
				});
			await initialized;
			const result = await rpc("tools/call", {
				name: "preview_open",
				arguments: { url, open: true, ...(tabId ? { tabId } : { reuseExistingTab: false }) },
			});
			if (typeof result !== "object" || result === null) throw new Error("T3 returned no preview result");
			if ("isError" in result && result.isError === true) {
				const content: unknown = "content" in result && Array.isArray(result.content) ? result.content[0] : undefined;
				throw new Error(content && typeof content === "object" && "text" in content ? String(content.text) : "T3 could not open the preview");
			}
			const status = "structuredContent" in result ? result.structuredContent : undefined;
			return status && typeof status === "object" && "tabId" in status && typeof status.tabId === "string" ? status.tabId : undefined;
		},
	};
}

export function recentMessages(ctx: ExtensionContext) {
	return ctx.sessionManager
		.getBranch()
		.flatMap((entry) => {
			if (entry.type !== "message" || (entry.message.role !== "user" && entry.message.role !== "assistant")) return [];
			const content = entry.message.content;
			const text = typeof content === "string" ? content : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
			return text ? [{ id: entry.id, text, label: `${entry.id}: ${text.replace(/\s+/g, " ").slice(0, 90)}` }] : [];
		})
		.slice(-20)
		.reverse();
}

export interface PlaybookPanel {
	readonly close: () => void;
	show(preview: T3Preview): Promise<void>;
}

export async function servePanel(file: string, ctx: ExtensionContext): Promise<PlaybookPanel> {
	const core = new Core({
		store: createStore(file),
		references,
		fetcher,
		checks,
		panes: { ownPane: () => null, focusPane: async () => ({ ok: false, error: "This Playbook is in T3 Preview" }) },
	});
	// Acquire the document socket before loading data or starting disk monitoring.
	const service = await serveK1(documentEndpoint(file), core);
	try {
		const loadError = core.load();
		if (loadError !== null) throw new Error(loadError);
		return startPanel(core, file, ctx, () => {
			service.close();
			core.stop();
		});
	} catch (error) {
		service.close();
		core.stop();
		throw error;
	}
}

function startPanel(core: Core, file: string, ctx: ExtensionContext, stopService: () => void): PlaybookPanel {
	const token = `/${randomUUID()}/`;
	const session = ctx.sessionManager.getSessionId();
	const assets = {
		"": Bun.file(new URL("../panel/index.html", import.meta.url)),
		"panel.js": Bun.file(new URL("../panel/panel.js", import.meta.url)),
		"panel.css": Bun.file(new URL("../panel/panel.css", import.meta.url)),
	};
	const headers = {
		"cache-control": "no-store",
		"content-security-policy": "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
		"referrer-policy": "no-referrer",
		"x-content-type-options": "nosniff",
	};
	const http = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		maxRequestBodySize: 2 * 1024 * 1024,
		async fetch(request, server) {
			const url = new URL(request.url);
			if (url.origin !== server.url.origin || !url.pathname.startsWith(token)) return new Response(null, { status: 404 });
			if (ctx.sessionManager.getSessionId() !== session) return new Response("Playbook session ended", { status: 410, headers });
			const route = url.pathname.slice(token.length);
			if (request.method === "GET" && (route === "" || route === "panel.js" || route === "panel.css")) {
				return new Response(assets[route], { headers });
			}
			const runValue = url.searchParams.get("run");
			const run = runValue === null ? null : parseRunId(runValue);
			if (runValue !== null && run === null) return Response.json({ error: "Invalid Run id" }, { status: 400, headers });
			const ref = run === null ? { kind: "template" as const } : { kind: "run" as const, run };
			if (request.method === "GET" && route === "state") {
				const after = Number(url.searchParams.get("after") ?? 0);
				if (!Number.isSafeInteger(after) || after < 0) return Response.json({ error: "Invalid timeline cursor" }, { status: 400, headers });
				const page = core.timeline(ref, after, 200);
				return Response.json({
					file,
					view: core.view(ref),
					runs: core.runs(),
					coordinator: core.coordinator().connected,
					entries: page.ok ? page.result.entries : [],
					more: page.ok && page.result.next_after !== undefined,
					messages: recentMessages(ctx).map(({ id, label }) => ({ id, label })),
				}, { headers });
			}
			if (request.method !== "POST" || route !== "action") return new Response(null, { status: 404 });
			if (request.headers.get("origin") !== url.origin || request.headers.get("content-type") !== "application/json") {
				return new Response(null, { status: 403 });
			}
			let input: unknown;
			try {
				input = await request.json();
			} catch {
				return Response.json({ error: "Invalid JSON" }, { status: 400, headers });
			}
			const bad = () => Response.json({ error: "Invalid Playbook action" }, { status: 400, headers });
			if (!input || typeof input !== "object" || !("op" in input)) return bad();
			const block = "block" in input && typeof input.block === "string" ? parseBlockId(input.block) : null;
			let error: string | null;
			switch (input.op) {
				case "edit": {
					if (!("expected" in input) || typeof input.expected !== "string" || !("text" in input) || typeof input.text !== "string") return bad();
					if (block && "field" in input && (input.field === "title" || input.field === "body" || input.field === "requirement")) {
						error = core.edit(ref, block, input.field, input.expected, input.text);
					} else if ("field" in input && input.field === "documentTitle") {
						error = core.setTitle(ref, input.expected, input.text);
					} else return bad();
					break;
				}
				case "revision":
					if (!block || !("text" in input) || typeof input.text !== "string") return bad();
					error = core.requestRevision(ref, block, input.text);
					break;
				case "status":
					if (!block || !("status" in input) || (input.status !== "todo" && input.status !== "done")) return bad();
					error = core.setStatus(ref, block, input.status);
					break;
				case "launch": {
					if (!("blocks" in input) || !Array.isArray(input.blocks)) return bad();
					const blocks: BlockId[] = [];
					for (const value of input.blocks) {
						const id = typeof value === "string" ? parseBlockId(value) : null;
						if (!id) return bad();
						blocks.push(id);
					}
					error = core.requestLaunch(ref, blocks);
					break;
				}
				case "stop":
					if (!block) return bad();
					error = core.requestStop(ref, block);
					break;
				case "post": {
					if (!("kind" in input)) return bad();
					const kind: RecordKind | null = input.kind === "update" || input.kind === "result" || input.kind === "failure" || input.kind === "retrospective" ? input.kind : null;
					if (!kind || ("block" in input && !block)) return bad();
					const message = "quote" in input ? recentMessages(ctx).find((entry) => entry.id === input.quote) : undefined;
					if ("quote" in input && !message) return Response.json({ error: "The selected message is no longer in the recent thread history" }, { status: 409, headers });
					const text = message?.text ?? ("text" in input && typeof input.text === "string" ? input.text : "");
					if (text.trim() === "") return bad();
					const result = core.postHuman(ref, kind, text, block, message?.id);
					error = result.ok ? null : result.error.message;
					break;
				}
				default:
					return bad();
			}
			return Response.json({ error }, { status: error === null ? 200 : 409, headers });
		},
	});
	const url = new URL(token, http.url).href;
	let tabId: string | undefined;
	let showing = Promise.resolve();
	return {
		close() {
			void http.stop(true);
			stopService();
		},
		show(preview) {
			const next = showing.then(async () => {
				try {
					tabId = await preview.open(url, tabId);
				} catch (error) {
					if (!tabId || !(error instanceof Error) || !/tab.*(not found|closed|does not exist|unknown)|unknown.*tab/i.test(error.message)) throw error;
					tabId = await preview.open(url);
				}
			});
			showing = next.catch(() => undefined);
			return next;
		},
	};
}
