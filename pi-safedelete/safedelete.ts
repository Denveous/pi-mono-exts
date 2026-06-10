import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DELETE_PATTERNS = [
	/\brm\s+/i,
	/\brmdir\s+/i,
	/\bdel\s+/i,
	/\brd\s+/i,
	/\bRemove-Item/i,
	/\bunlink/i,
	/\bfs\.rm/i,
	/\bfs\.unlink/i,
	/\bunlinkSync/i,
	/\brmSync/i,
	/\brm\s+-rf/i,
];

const WRITE_PATTERNS = [
	/\bfs\.write/i,
	/\bwriteFile/i,
	/\bwriteSync/i,
];

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		const cmd = event.toolName === "bash" ? (event.input as any).command ?? "" : "";
		if (!cmd) return;

		const isDelete = DELETE_PATTERNS.some(p => p.test(cmd));
		const isWrite = !isDelete && WRITE_PATTERNS.some(p => p.test(cmd));

		if (isDelete) {
			const allowed = await ctx.ui.confirm(
				"Delete Confirmation",
				`Delete command detected:\n\n${cmd.slice(0, 500)}\n\nAllow this?`,
			);
			if (!allowed) {
				return { block: true, reason: "User denied delete operation" };
			}
		}

		if (isWrite) {
			const allowed = await ctx.ui.confirm(
				"Write Confirmation",
				`Write command detected:\n\n${cmd.slice(0, 500)}\n\nAllow this?`,
			);
			if (!allowed) {
				return { block: true, reason: "User denied write operation" };
			}
		}
	});
}
