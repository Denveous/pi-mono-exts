import { createAssistantMessageEventStream, type Api, type AssistantMessage, type AssistantMessageEventStream, type Context, type ImageContent, type Message, type Model, type SimpleStreamOptions, type StopReason, type TextContent, type ThinkingContent, type ToolCall, type UserMessage, type ToolResultMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function sanitize(s: string): string {
	return s.replace(/[\uD800-\uDFFF]/g, "\uFFFD");
}

function convertMessages(context: Context): any[] {
	const msgs: any[] = [];
	if (context.systemPrompt) msgs.push({ role: "system", content: sanitize(context.systemPrompt) });

	for (const msg of context.messages) {
		if (msg.role === "user") {
			const userMsg = msg as UserMessage;
			if (typeof userMsg.content === "string") {
				if (userMsg.content.trim()) msgs.push({ role: "user", content: sanitize(userMsg.content) });
			} else {
				const parts = userMsg.content.map(c =>
					c.type === "text" ? { type: "text", text: sanitize(c.text) }
					: { type: "image_url", image_url: { url: `data:${c.mimeType};base64,${c.data}` } }
				);
				if (parts.length) msgs.push({ role: "user", content: parts });
			}
		} else if (msg.role === "assistant") {
			const asst = msg as AssistantMessage;
			const textParts: string[] = [];
			const toolCalls: { id: string; type: "function"; function: { name: string; arguments: string } }[] = [];
			let reasoning = "";
			for (const block of asst.content) {
				if (block.type === "text" && block.text.trim()) textParts.push(sanitize(block.text));
				else if (block.type === "toolCall") toolCalls.push({ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.arguments) } });
				else if (block.type === "thinking" && (block as ThinkingContent).thinking.trim()) reasoning += sanitize((block as ThinkingContent).thinking);
			}
			if (!textParts.length && !toolCalls.length && !reasoning) continue;
			const m: any = { role: "assistant", content: textParts.length ? textParts.join("\n") : "" };
			if (reasoning) m.reasoning_content = reasoning;
			if (toolCalls.length) m.tool_calls = toolCalls;
			msgs.push(m);
		} else if (msg.role === "toolResult") {
			const tr = msg as ToolResultMessage;
			const textParts = tr.content.filter(c => c.type === "text").map(c => sanitize((c as TextContent).text));
			msgs.push({ role: "tool", tool_call_id: tr.toolCallId, content: textParts.length ? textParts.join("\n") : "" });
		}
	}
	const cleaned: any[] = [];
	for (let i = 0; i < msgs.length; i++) {
		const msg = msgs[i];
		if (msg.role === "assistant" && msg.tool_calls?.length) {
			const requiredIds = new Set<string>(msg.tool_calls.map((tc: any) => tc.id));
			let j = i + 1;
			while (j < msgs.length && msgs[j].role === "tool") { requiredIds.delete(msgs[j].tool_call_id); j++; }
			if (requiredIds.size > 0) { i = j - 1; continue; }
		}
		cleaned.push(msg);
	}
	return cleaned;
}

function convertTools(tools: any[] | undefined): any[] | undefined {
	if (!tools?.length) return undefined;
	return tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

function mapStopReason(finishReason: string | null): StopReason {
	switch (finishReason) {
		case "stop": return "stop";
		case "length": case "max_tokens": return "length";
		case "tool_calls": return "toolUse";
		default: return "stop";
	}
}

function streamOpenCodeFree(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	(async () => {
		const output: AssistantMessage = {
			role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop", timestamp: Date.now(),
		};

		try {
			const tools = convertTools(context.tools);
			const body: any = {
				model: model.id,
				messages: convertMessages(context),
				stream: true,
				stream_options: { include_usage: true },
				max_tokens: options?.maxTokens ?? model.maxTokens,
			};
			if (tools?.length) body.tools = tools;

			const res = await fetch(model.baseUrl + "/chat/completions", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal: options?.signal,
			});

			if (!res.ok) {
				const text = await res.text();
				throw new Error(`Zen API error ${res.status}: ${text}`);
			}

			const reader = res.body?.getReader();
			if (!reader) throw new Error("No response body");
			const decoder = new TextDecoder();
			let buf = "";

			stream.push({ type: "start", partial: output });

			let thinkingIndex = -1;
			let textIndex = -1;
			const toolCallMap = new Map<number, { id: string; name: string; args: string }>();

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				const lines = buf.split("\n");
				buf = lines.pop() ?? "";

				for (const line of lines) {
					if (!line.startsWith("data: ")) continue;
					const payload = line.slice(6).trim();
					if (payload === "[DONE]") continue;

					let chunk: any;
					try { chunk = JSON.parse(payload); } catch { continue; }

					const delta = chunk.choices?.[0]?.delta;
					const finishReason = chunk.choices?.[0]?.finish_reason;
					if (!delta) continue;

					if (delta.reasoning_content) {
						if (thinkingIndex === -1) {
							thinkingIndex = output.content.length;
							output.content.push({ type: "thinking", thinking: "" });
							stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
						}
						const block = output.content[thinkingIndex] as ThinkingContent;
						block.thinking += delta.reasoning_content;
						stream.push({ type: "thinking_delta", contentIndex: thinkingIndex, delta: delta.reasoning_content, partial: output });
					}

					if (delta.content) {
						if (textIndex === -1) {
							textIndex = output.content.length;
							output.content.push({ type: "text", text: "" });
							stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
						}
						const block = output.content[textIndex] as TextContent;
						block.text += delta.content;
						stream.push({ type: "text_delta", contentIndex: textIndex, delta: delta.content, partial: output });
					}

					if (delta.tool_calls) {
						for (const tc of delta.tool_calls) {
							const idx = tc.index ?? 0;
							if (tc.id) {
								if (!toolCallMap.has(idx)) toolCallMap.set(idx, { id: tc.id, name: "", args: "" });
								toolCallMap.get(idx)!.id = tc.id;
							}
							if (tc.function?.name) {
								if (!toolCallMap.has(idx)) toolCallMap.set(idx, { id: "", name: "", args: "" });
								toolCallMap.get(idx)!.name += tc.function.name;
							}
							if (tc.function?.arguments) {
								if (!toolCallMap.has(idx)) toolCallMap.set(idx, { id: "", name: "", args: "" });
								const existing = toolCallMap.get(idx)!;
								if (!existing.id) existing.id = tc.id ?? `call_${idx}`;
								if (!existing.name) existing.name = tc.function?.name ?? "";
								existing.args += tc.function.arguments;
							}
						}

						for (const [, tc] of toolCallMap) {
							const existingIdx = output.content.findIndex(c => c.type === "toolCall" && (c as ToolCall).id === tc.id);
							if (existingIdx === -1) {
								const tcBlock: ToolCall & { partialArgs: string } = { type: "toolCall", id: tc.id, name: tc.name, arguments: {}, partialArgs: "" };
								output.content.push(tcBlock);
								stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
							}
						}

						for (const [, tc] of toolCallMap) {
							const existingIdx = output.content.findIndex(c => c.type === "toolCall" && (c as ToolCall).id === tc.id);
							if (existingIdx === -1) continue;
							const block = output.content[existingIdx] as ToolCall & { partialArgs: string };
							const prevLen = block.partialArgs.length;
							block.partialArgs = tc.args;
							const newDelta = block.partialArgs.slice(prevLen);
							if (newDelta) {
								try { block.arguments = JSON.parse(block.partialArgs); } catch {}
								stream.push({ type: "toolcall_delta", contentIndex: existingIdx, delta: newDelta, partial: output });
							}
						}
					}

					if (finishReason) {
						output.stopReason = mapStopReason(finishReason);
					}

					if (chunk.usage) {
						output.usage.input = chunk.usage.prompt_tokens ?? output.usage.input;
						output.usage.output = chunk.usage.completion_tokens ?? output.usage.output;
						output.usage.totalTokens = chunk.usage.total_tokens ?? (output.usage.input + output.usage.output);
					}
				}
			}

			if (thinkingIndex >= 0) stream.push({ type: "thinking_end", contentIndex: thinkingIndex, content: (output.content[thinkingIndex] as ThinkingContent).thinking, partial: output });
			if (textIndex >= 0) stream.push({ type: "text_end", contentIndex: textIndex, content: (output.content[textIndex] as TextContent).text, partial: output });

			for (let i = 0; i < output.content.length; i++) {
				const block = output.content[i];
				if (block.type === "toolCall" && (block as any).partialArgs !== undefined) {
					delete (block as any).partialArgs;
					stream.push({ type: "toolcall_end", contentIndex: i, toolCall: block as ToolCall, partial: output });
				}
			}

			output.usage.totalTokens = output.usage.totalTokens || (output.usage.input + output.usage.output);
			output.usage.cost.total = output.usage.cost.input + output.usage.cost.output + output.usage.cost.cacheRead + output.usage.cost.cacheWrite;

			if (options?.signal?.aborted) throw new Error("Aborted");
			stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output } as any);
			stream.end();
		}
	})();
	return stream;
}

const BASE_MODEL = {
	reasoning: true,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
};
const FREE_IDS = ["big-pickle"];
const isFree = (id: string) => id.endsWith("-free") || FREE_IDS.includes(id);

export default function (pi: ExtensionAPI) {
	pi.registerProvider("opencode-pi", {
		baseUrl: "https://opencode.ai/zen/v1",
		apiKey: "sk-noop",
		api: "opencode-pi-free",
		models: [
			{ ...BASE_MODEL, id: "big-pickle", name: "Big Pickle (free)" },
			{ ...BASE_MODEL, id: "deepseek-v4-flash-free", name: "DeepSeek V4 Flash (free)" },
			{ ...BASE_MODEL, id: "minimax-m2.5-free", name: "MiniMax M2.5 (free)", reasoning: false },
			{ ...BASE_MODEL, id: "nemotron-3-super-free", name: "Nemotron 3 Super (free)" },
			{ ...BASE_MODEL, id: "ring-2.6-1t-free", name: "Ring 2.6 1T (free)" },
		],
		streamSimple: streamOpenCodeFree,
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			const res = await fetch("https://opencode.ai/zen/v1/models");
			if (!res.ok) return;
			const data = (await res.json()) as { data: { id: string }[] };
			const freeModels = data.data
				.filter(m => isFree(m.id))
				.map(m => ({
					...BASE_MODEL,
					id: m.id,
					name: `${m.id.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase())} (free)`,
				}));
			if (freeModels.length) {
				pi.registerProvider("opencode-pi", {
					baseUrl: "https://opencode.ai/zen/v1",
					apiKey: "sk-noop",
					api: "opencode-pi-free",
					models: freeModels,
					streamSimple: streamOpenCodeFree,
				});
				ctx.ui.notify(`opencode-pi: loaded ${freeModels.length} free models from API`, "info");
			}
		} catch {}
	});
}
