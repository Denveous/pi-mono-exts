import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SKILLS_DIR = join(homedir(), ".pi", "agent", "skills", "superpowers");

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		if (!existsSync(SKILLS_DIR)) return {};
		try {
			const bootstrap = readFileSync(join(SKILLS_DIR, "using-superpowers", "SKILL.md"), "utf8");
			const skillDirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
				.filter(d => d.isDirectory())
				.map(d => `- superpowers:${d.name}`);
			const skillList = skillDirs.join("\n");
			const injection = `\n\n<SUPERPOWERS>\nYou have superpowers installed.\n\nAvailable skills:\n${skillList}\n\nBootstrap instructions:\n${bootstrap}\n</SUPERPOWERS>`;
			return { systemPrompt: event.systemPrompt + injection };
		} catch (e) {
			return {};
		}
	});
}
