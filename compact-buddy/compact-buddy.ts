import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentMessage, TextContent, ToolCall, ThinkingContent } from "@earendil-works/pi-ai";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const CONFIG_PATH = join(process.env.USERPROFILE || process.env.HOME || "~", ".pi", "compact-buddy.json");
const DEFAULT_MODEL = "big-pickle";

function loadConfig(): string {
	try { return existsSync(CONFIG_PATH) ? (JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as any).model ?? DEFAULT_MODEL : DEFAULT_MODEL; } catch { return DEFAULT_MODEL; }
}
function saveConfig(model: string) {
	try { mkdirSync(join(process.env.USERPROFILE || process.env.HOME || "~", ".pi"), { recursive: true }); writeFileSync(CONFIG_PATH, JSON.stringify({ model })); } catch {}
}

const COMPACT_MODEL_KEY = "compact-model";
const COMPACT_SYSTEM = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished

Output the complete updated summary using the same EXACT format as above.`;

function serializeMessages(msgs: AgentMessage[]): string {
	const lines: string[] = [];
	for (const msg of msgs) {
		if (msg.role === "user") {
			const text = typeof msg.content === "string" ? msg.content : msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
			if (text.trim()) lines.push(`[User]: ${text.trim()}`);
		} else if (msg.role === "assistant") {
			for (const block of (msg as any).content ?? []) {
				if (block.type === "text" && block.text?.trim()) lines.push(`[Assistant]: ${block.text.trim()}`);
				else if (block.type === "toolCall") {
					const tc = block as ToolCall;
					lines.push(`[Tool Call]: ${tc.name}(${JSON.stringify(tc.arguments).slice(0, 200)})`);
				} else if (block.type === "thinking" && (block as ThinkingContent).thinking?.trim()) {
					lines.push(`[Thinking]: ${(block as ThinkingContent).thinking.trim().slice(0, 500)}`);
				}
			}
		} else if (msg.role === "toolResult") {
			const text = (msg as any).content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") ?? "";
			if (text.trim()) lines.push(`[Tool Result]: ${text.trim().slice(0, 2000)}`);
		}
	}
	return lines.join("\n\n");
}

async function compactWithFreeModel(model: string, messages: AgentMessage[], previousSummary?: string, signal?: AbortSignal): Promise<string> {
	const convo = serializeMessages(messages);
	let promptText = `<conversation>\n${convo}\n</conversation>\n\n`;
	if (previousSummary) {
		promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
		promptText += UPDATE_PROMPT;
	} else {
		promptText += SUMMARIZATION_PROMPT;
	}

	const res = await fetch("https://opencode.ai/zen/v1/chat/completions", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ model, messages: [{ role: "system", content: COMPACT_SYSTEM }, { role: "user", content: promptText }], max_tokens: 4096 }),
		signal,
	});

	if (!res.ok) throw new Error(`Free model error ${res.status}: ${await res.text()}`);
	const data = await res.json() as any;
	return data.choices?.[0]?.message?.content ?? "";
}

export default function compactBuddy(pi: ExtensionAPI) {
	let compactModel = loadConfig();

	pi.on("session_start", async (_event, ctx) => {
		const saved = loadConfig();
		if (saved) compactModel = saved;
		ctx.ui.setStatus("compact-buddy", `compact: ${compactModel}`);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		try {
			ctx.ui.notify(`compact-buddy: compacting with ${compactModel}...`, "info");
			const summary = await compactWithFreeModel(
				compactModel,
				event.preparation.messagesToSummarize,
				event.preparation.previousSummary,
				event.signal,
			);
			if (!summary) throw new Error("Empty summary");
			ctx.ui.notify(`compact-buddy: done (${summary.length} chars)`, "info");
			return {
				compaction: {
					summary,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
				},
			};
		} catch (err) {
			ctx.ui.notify(`compact-buddy: failed (${err instanceof Error ? err.message : String(err)}), falling back to main model`, "warning");
			return {};
		}
	});

	pi.registerCommand("compact-model", {
		description: "compact-buddy: set/get free model for compaction",
		handler: async (args = "", ctx) => {
			const sub = args.trim().split(/\s+/)[0];
			if (!sub) {
				ctx.ui.notify(`compact-buddy: using ${compactModel}`, "info");
				return;
			}
			compactModel = sub;
			saveConfig(compactModel);
			ctx.ui.setStatus("compact-buddy", `compact: ${compactModel}`);
			ctx.ui.notify(`compact-buddy: set to ${compactModel}`, "info");
		},
	});
}
