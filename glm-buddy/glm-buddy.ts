import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PEAK_START_UTC8 = 14;
const PEAK_END_UTC8 = 18;
const PEAK_MESSAGE_LIMIT = 1;
const STATUS_KEY = "glm-buddy";
const QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";

function utc8Hour(): number {
	return (new Date().getUTCHours() + 8) % 24;
}

function isPeak(): boolean {
	const h = utc8Hour();
	return h >= PEAK_START_UTC8 && h < PEAK_END_UTC8;
}

function peakEndsLocal(): string {
	const now = new Date();
	const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
	const peakEndUtc8 = new Date(now);
	peakEndUtc8.setTime(utcMs);
	if (utc8Hour() >= PEAK_START_UTC8) {
		peakEndUtc8.setUTCHours(PEAK_END_UTC8 - 8, 0, 0, 0);
	} else {
		peakEndUtc8.setUTCHours(PEAK_END_UTC8 - 8 + 24, 0, 0, 0);
	}
	return peakEndUtc8.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function isGLM(model: any): boolean {
	if (!model) return false;
	const id = (model.id ?? "").toLowerCase();
	const provider = typeof model.provider === "string" ? model.provider : "";
	return provider === "zai" || id.includes("glm") || provider.toLowerCase().includes("zhipu") || provider.toLowerCase().includes("z.ai");
}

function formatReset(ms: number): string {
	return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatResetFull(ms: number): string {
	return new Date(ms).toLocaleString([], { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function formatDuration(ms: number): string {
	const totalMin = Math.floor(ms / 60000);
	const h = Math.floor(totalMin / 60);
	const m = totalMin % 60;
	if (h > 0) return `${h}hr ${m}m`;
	return `${m}m`;
}

function timeUntilPeakEnd(): number {
	const now = new Date();
	const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
	const peakEnd = new Date(now);
	peakEnd.setTime(utcMs);
	peakEnd.setUTCHours(PEAK_END_UTC8 - 8, 0, 0, 0);
	if (peakEnd.getTime() <= now.getTime()) peakEnd.setDate(peakEnd.getDate() + 1);
	return peakEnd.getTime() - now.getTime();
}

interface QuotaLimit {
	type: string;
	percentage: number;
	nextResetTime: number;
}

export default function glmBuddy(pi: ExtensionAPI) {
	let peakMessages = 0;
	let inPeak = false;
	let override = false;
	let quotaPercent: number | null = null;
	let quotaResetEpoch: number | null = null;
	let allLimits: QuotaLimit[] = [];
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	async function fetchQuota(ctx: any) {
		if (!isGLM(ctx.model)) return;
		try {
			const apiKey = await ctx.modelRegistry.getApiKeyForProvider("zhipuai-coding-plan");
			if (!apiKey) return;
			const res = await fetch(QUOTA_URL, { headers: { "Authorization": `Bearer ${apiKey}` } });
			if (!res.ok) return;
			const raw = await res.json();
			const limits: QuotaLimit[] = raw.data?.limits ?? [];
			allLimits = limits;
			const tokens = limits.find(l => l.type === "TOKENS_LIMIT");
			if (tokens) {
				quotaPercent = tokens.percentage;
				quotaResetEpoch = tokens.nextResetTime;
			}
		} catch {}
		updateStatus(ctx);
	}

	function progressBar(pct: number): string {
		const remaining = 100 - pct;
		const width = 12;
		const filled = Math.round((remaining / 100) * width);
		const empty = width - filled;
		const reset = quotaResetEpoch ? formatReset(quotaResetEpoch) : "";
		const resetStr = reset ? ` (resets ${reset})` : "";
		return `[${"█".repeat(filled)}${"░".repeat(empty)}] ${remaining}% left${resetStr}`;
	}

	function updateStatus(ctx: any) {
		if (!isGLM(ctx.model)) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const parts: string[] = [];
		if (isPeak()) {
			const remaining = Math.max(0, PEAK_MESSAGE_LIMIT - peakMessages);
			const timeLeft = timeUntilPeakEnd();
			parts.push(`🔴 peak: ${remaining}/${PEAK_MESSAGE_LIMIT} (${formatDuration(timeLeft)} left)${override ? " [override]" : ""}`);
		} else {
			parts.push("🟢 off-peak");
		}
		if (quotaPercent !== null) parts.push(progressBar(quotaPercent));
		ctx.ui.setStatus(STATUS_KEY, parts.join(" │ "));
	}

	function boxLine(content: string, width = 76): string {
		return `│${content.padEnd(width)}│`;
	}

	pi.on("session_start", async (_event, ctx) => {
		inPeak = isPeak();
		if (!inPeak) peakMessages = 0;
		await fetchQuota(ctx);
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = setInterval(async () => { try { await fetchQuota(ctx); } catch { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } } }, 15 * 1000);
		updateStatus(ctx);
	});

	pi.on("session_shutdown", () => {
		if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
	});

	pi.on("model_select", async (_event, ctx) => {
		quotaPercent = null;
		quotaResetEpoch = null;
		allLimits = [];
		await fetchQuota(ctx);
		updateStatus(ctx);
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		if (override) return { action: "continue" };
		if (!isGLM(ctx.model)) return { action: "continue" };

		const peak = isPeak();
		if (!peak) {
			if (inPeak) { peakMessages = 0; inPeak = false; }
			updateStatus(ctx);
			return { action: "continue" };
		}

		if (!inPeak) { inPeak = true; peakMessages = 0; }

		if (peakMessages >= PEAK_MESSAGE_LIMIT) {
			ctx.ui.notify(`[glm-buddy] Peak hours active. ${peakMessages}/${PEAK_MESSAGE_LIMIT} messages used. Limit reached. Peak ends ~${peakEndsLocal()}. Use /glm override to bypass.`, "warning");
			return { action: "handled" };
		}

		peakMessages++;
		updateStatus(ctx);
		ctx.ui.notify(`[glm-buddy] Peak message ${peakMessages}/${PEAK_MESSAGE_LIMIT}.`, "warning");
		return { action: "continue" };
	});

	pi.registerCommand("glm", {
		description: "glm-buddy: peak hour status, quota, override, reset",
		handler: async (args, ctx) => {
			const sub = args.trim().split(/\s+/)[0];
			if (sub === "override") {
				override = !override;
				updateStatus(ctx);
				ctx.ui.notify(`glm-buddy: override ${override ? "ON - limits bypassed" : "OFF"}`, "info");
			} else if (sub === "reset") {
				peakMessages = 0;
				updateStatus(ctx);
				ctx.ui.notify("glm-buddy: counter reset", "info");
			} else if (sub === "quota") {
				await fetchQuota(ctx);
				if (allLimits.length === 0) {
					ctx.ui.notify("glm-buddy: could not fetch quota", "warning");
				} else {
					const peak = isPeak();
					const w = 76;
					const horiz = "─".repeat(w);
					const lines: string[] = [];
					lines.push(`╭${horiz}╮`);
					lines.push(boxLine(">_ glm-buddy", w));
					lines.push(boxLine("", w));
					lines.push(boxLine(`Model:       ${ctx.model?.id ?? "unknown"}`, w));
					lines.push(boxLine(`Provider:    zhipuai-coding-plan`, w));
					lines.push(boxLine(`Directory:   ${ctx.cwd ?? "~"}`, w));
					const sessionName = ctx.sessionManager?.getSessionName?.() ?? "unknown";
					lines.push(boxLine(`Session:     ${sessionName}`, w));
					const peakStatus = peak ? `🔴 PEAK (${formatDuration(timeUntilPeakEnd())} left)` : "🟢 off-peak";
					lines.push(boxLine(`Peak status: ${peakStatus}`, w));
					lines.push(boxLine(`Peak msgs:   ${peakMessages}/${PEAK_MESSAGE_LIMIT} ${override ? "(override ON)" : ""}`, w));
					lines.push(boxLine("", w));
					for (const lim of allLimits) {
						const pct = lim.percentage;
						const remaining = 100 - pct;
						const barW = 20;
						const filled = Math.round((remaining / 100) * barW);
						const empty = barW - filled;
						const label = lim.type === "TOKENS_LIMIT" ? "5h limit" : "Requests";
						const reset = lim.nextResetTime ? formatResetFull(lim.nextResetTime) : "unknown";
						lines.push(boxLine(`${label.padEnd(12)} [${"█".repeat(filled)}${"░".repeat(empty)}] ${remaining}% left (resets ${reset})`, w));
					}
					lines.push(boxLine("", w));
					lines.push(boxLine("Use /glm override to bypass peak limits", w));
					lines.push(`╰${horiz}╯`);
					ctx.ui.notify(lines.join("\n"), "info");
				}
			} else {
				const glm = isGLM(ctx.model);
				const peak = isPeak();
				const remaining = Math.max(0, PEAK_MESSAGE_LIMIT - peakMessages);
				const pctLeft = quotaPercent !== null ? `${100 - quotaPercent}% left` : "unknown";
				ctx.ui.notify(
					`glm-buddy: ${peak ? "🔴 PEAK" : "🟢 off-peak"} | model: ${glm ? ctx.model?.id : "not GLM"} | msgs: ${peakMessages}/${PEAK_MESSAGE_LIMIT} (${remaining} left) | quota: ${pctLeft} | override: ${override}`,
					"info"
				);
			}
		},
	});
}
