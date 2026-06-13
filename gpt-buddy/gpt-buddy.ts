import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "gpt-buddy";
const WHAM_URL = "https://chatgpt.com/backend-api/wham/usage";

function isGPT(model: any): boolean {
	if (!model) return false;
	const id = (model.id ?? "").toLowerCase();
	const provider = typeof model.provider === "string" ? model.provider : "";
	return provider === "openai-codex" || provider === "openai" || provider === "azure-openai-responses" || id.startsWith("gpt") || id.startsWith("o1") || id.startsWith("o3");
}

function formatResetCodex(ts: number): string {
	const d = new Date(ts * 1000);
	const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true });
	const month = d.toLocaleString([], { month: "short" });
	return `${time} on ${month} ${d.getDate()}`;
}

interface RateWindow {
	used_percent: number;
	limit_window_seconds: number;
	reset_after_seconds: number;
	reset_at: number;
}
interface WhamResponse {
	email: string;
	plan_type: string;
	rate_limit: {
		allowed: boolean;
		limit_reached: boolean;
		primary_window: RateWindow;
		secondary_window: RateWindow;
	};
}

function bar(pct: number, w: number): string {
	const remaining = 100 - pct;
	const filled = Math.round((remaining / 100) * w);
	const empty = w - filled;
	return `[${"█".repeat(filled)}${"░".repeat(empty)}] ${remaining}% left`;
}

export default function gptBuddy(pi: ExtensionAPI) {
	let wham: WhamResponse | null = null;
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	async function fetchQuota(ctx: any, force = false) {
		if (!force && !isGPT(ctx.model)) return;
		try {
			const apiKey = await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
			if (!apiKey) return;
			const res = await fetch(WHAM_URL, { headers: { "Authorization": `Bearer ${apiKey}` } });
			if (!res.ok) return;
			wham = await res.json() as WhamResponse;
		} catch {}
		updateStatus(ctx);
	}
	function updateStatus(ctx: any) {
		if (!isGPT(ctx.model) || !wham) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const p = wham.rate_limit.primary_window;
		if (!p) return;
		const s = wham.rate_limit.secondary_window;
		if (s && s.used_percent >= 99) {
			ctx.ui.setStatus(STATUS_KEY, `${bar(s.used_percent, 12)} (resets ${formatResetCodex(s.reset_at)})`);
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, `${bar(p.used_percent, 12)} (resets ${formatResetCodex(p.reset_at)})`);
	}

	pi.on("session_start", async (_event, ctx) => {
		await fetchQuota(ctx);
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = setInterval(async () => { try { await fetchQuota(ctx); } catch { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } } }, 180 * 1000);
		updateStatus(ctx);
	});
	pi.on("session_shutdown", () => {
		if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
	});
	pi.on("model_select", async (_event, ctx) => {
		wham = null;
		await fetchQuota(ctx);
		updateStatus(ctx);
	});

	function cap(value: unknown, w: number): string {
		const s = typeof value === "string" && value ? value : "unknown";
		if (s.length <= w) return s;
		return s.slice(0, w - 3) + "...";
	}

	pi.registerCommand("gpt", {
		description: "gpt-buddy: quota status",
		handler: async (args = "", ctx) => {
			const sub = args.trim().split(/\s+/)[0];
			if (sub === "quota" || sub === "usage" || sub === "") {
				await fetchQuota(ctx, true);
				if (!wham) {
					ctx.ui.notify("gpt-buddy: could not fetch quota", "warning");
					return;
				}
				const p = wham.rate_limit.primary_window;
				const s = wham.rate_limit.secondary_window;
				const w = 79;
				const horiz = "─".repeat(w);
				const L = (t: string) => `│  ${t.padEnd(w - 4)}  │`;
				const lines: string[] = [];
				lines.push(`╭${horiz}╮`);
				lines.push(L(">_ gpt-buddy"));
				lines.push(L(""));
				lines.push(L(`Account:              ${wham.email} (${wham.plan_type.charAt(0).toUpperCase() + wham.plan_type.slice(1)})`));
				const modelLabel = ctx.model?.id ?? "unknown";
				lines.push(L(`Model:                ${modelLabel}`));
				lines.push(L(`Directory:            ${cap(ctx.cwd ?? "~", 52)}`));
				const sessionName = typeof ctx.sessionManager?.getSessionName === "function" ? ctx.sessionManager.getSessionName() ?? "unknown" : "unknown";
				lines.push(L(`Session:              ${cap(sessionName, 52)}`));
				lines.push(L(""));
				if (p) {
					const pLine = `5h limit:             ${bar(p.used_percent, 13)} (resets ${formatResetCodex(p.reset_at)})`;
					lines.push(L(pLine));
					if (s) {
						const sLine = `Weekly limit:         ${bar(s.used_percent, 13)} (resets ${formatResetCodex(s.reset_at)})`;
						lines.push(L(sLine));
					}
				}
				lines.push(`╰${horiz}╯`);
				ctx.ui.notify(lines.join("\n"), "info");
			}
		},
	});
}
