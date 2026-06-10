import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, rmSync, renameSync, copyFileSync, appendFileSync } from "node:fs";
import { dirname, basename, join, resolve, relative, extname, isAbsolute } from "node:path";
import { homedir } from "node:os";

function expandPath(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return homedir() + p.slice(1);
	return p;
}

function resolvePath(p: string): string {
	return resolve(expandPath(p));
}

const readTextFileTool = defineTool({
	name: "read_text_file",
	label: "Read File",
	description: "Read the complete contents of a file as text. Use head/tail for partial reads.",
	parameters: Type.Object({
		path: Type.String({ description: "Path to the file" }),
		head: Type.Optional(Type.Number({ description: "Read only first N lines" })),
		tail: Type.Optional(Type.Number({ description: "Read only last N lines" })),
	}),
	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const resolved = resolvePath(params.path);
		if (!existsSync(resolved)) return { content: [{ type: "text", text: `File not found: ${resolved}` }], isError: true };
		const content = readFileSync(resolved, "utf-8");
		let output = content;
		if (params.head) {
			output = content.split("\n").slice(0, params.head).join("\n");
		} else if (params.tail) {
			output = content.split("\n").slice(-params.tail).join("\n");
		}
		return { content: [{ type: "text", text: output }] };
	},
});

const readMultipleFilesTool = defineTool({
	name: "read_multiple_files",
	label: "Read Multiple Files",
	description: "Read multiple files simultaneously. Returns each file's content with its path.",
	parameters: Type.Object({
		paths: Type.Array(Type.String({ description: "Array of file paths to read" }), { description: "Files to read" }),
	}),
	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const results = params.paths.map(p => {
			const resolved = resolvePath(p);
			if (!existsSync(resolved)) return { path: p, error: "File not found" };
			try {
				return { path: p, content: readFileSync(resolved, "utf-8") };
			} catch (e: any) {
				return { path: p, error: e.message };
			}
		});
		return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
	},
});

const writeFileTool = defineTool({
	name: "write_file",
	label: "Write File",
	description: "Create or overwrite a file with content. Creates parent directories automatically.",
	parameters: Type.Object({
		path: Type.String({ description: "Path to write to" }),
		content: Type.String({ description: "Content to write" }),
	}),
	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const resolved = resolvePath(params.path);
		const dir = dirname(resolved);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(resolved, params.content, "utf-8");
		return { content: [{ type: "text", text: `Wrote ${params.content.length} bytes to ${resolved}` }] };
	},
});

const editFileTool = defineTool({
	name: "edit_file",
	label: "Edit File",
	description: "Make line-based edits to a text file. Each edit replaces exact text sequences. Returns a diff.",
	parameters: Type.Object({
		path: Type.String({ description: "Path to the file" }),
		edits: Type.Array(Type.Object({
			oldText: Type.String({ description: "Exact text to find" }),
			newText: Type.String({ description: "Replacement text" }),
		}), { description: "Array of edits to apply" }),
		dryRun: Type.Optional(Type.Boolean({ description: "Preview changes without writing" })),
	}),
	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const resolved = resolvePath(params.path);
		if (!existsSync(resolved)) return { content: [{ type: "text", text: `File not found: ${resolved}` }], isError: true };
		const original = readFileSync(resolved, "utf-8");
		let current = original;
		const diffs: string[] = [];
		for (const edit of params.edits) {
			if (!current.includes(edit.oldText)) {
				return { content: [{ type: "text", text: `oldText not found in file: ${edit.oldText.substring(0, 80)}...` }], isError: true };
			}
			const before = current;
			current = current.replace(edit.oldText, edit.newText);
			const oldLines = edit.oldText.split("\n");
			const newLines = edit.newText.split("\n");
			diffs.push(`--- ${edit.oldText.substring(0, 60)}`);
			diffs.push(`- ${oldLines.length} lines`);
			diffs.push(`+ ${newLines.length} lines`);
		}
		if (!params.dryRun) {
			writeFileSync(resolved, current, "utf-8");
		}
		return { content: [{ type: "text", text: params.dryRun ? `Dry run:\n${diffs.join("\n")}` : `Applied ${params.edits.length} edit(s) to ${resolved}\n${diffs.join("\n")}` }] };
	},
});

const createDirectoryTool = defineTool({
	name: "create_directory",
	label: "Create Directory",
	description: "Create a directory (and parents). Succeeds silently if exists.",
	parameters: Type.Object({
		path: Type.String({ description: "Directory path to create" }),
	}),
	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const resolved = resolvePath(params.path);
		mkdirSync(resolved, { recursive: true });
		return { content: [{ type: "text", text: `Created: ${resolved}` }] };
	},
});

const listDirectoryTool = defineTool({
	name: "list_directory",
	label: "List Directory",
	description: "List files and directories. [FILE] and [DIR] prefixes distinguish entries.",
	parameters: Type.Object({
		path: Type.String({ description: "Directory to list" }),
	}),
	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const resolved = resolvePath(params.path);
		if (!existsSync(resolved)) return { content: [{ type: "text", text: `Directory not found: ${resolved}` }], isError: true };
		const entries = readdirSync(resolved).map(name => {
			const full = join(resolved, name);
			try {
				const s = statSync(full);
				return s.isDirectory() ? `[DIR]  ${name}` : `[FILE] ${name}`;
			} catch {
				return `[????] ${name}`;
			}
		});
		return { content: [{ type: "text", text: entries.join("\n") || "(empty)" }] };
	},
});

const listDirectoryWithSizesTool = defineTool({
	name: "list_directory_with_sizes",
	label: "List Directory (sizes)",
	description: "List files and directories with sizes.",
	parameters: Type.Object({
		path: Type.String({ description: "Directory to list" }),
		sortBy: Type.Optional(Type.Union([Type.Literal("name"), Type.Literal("size")], { description: "Sort by name or size" })),
	}),
	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const resolved = resolvePath(params.path);
		if (!existsSync(resolved)) return { content: [{ type: "text", text: `Directory not found: ${resolved}` }], isError: true };
		const entries = readdirSync(resolved).map(name => {
			const full = join(resolved, name);
			try {
				const s = statSync(full);
				return { name, isDir: s.isDirectory(), size: s.size };
			} catch {
				return { name, isDir: false, size: 0 };
			}
		});
		const sortBy = params.sortBy || "name";
		if (sortBy === "size") entries.sort((a, b) => b.size - a.size);
		else entries.sort((a, b) => a.name.localeCompare(b.name));
		const lines = entries.map(e => {
			const prefix = e.isDir ? "[DIR] " : "[FILE]";
			const size = e.isDir ? "" : ` (${formatSize(e.size)})`;
			return `${prefix} ${e.name}${size}`;
		});
		return { content: [{ type: "text", text: lines.join("\n") || "(empty)" }] };
	},
});

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

const directoryTreeTool = defineTool({
	name: "directory_tree",
	label: "Directory Tree",
	description: "Recursive tree view of files and directories.",
	parameters: Type.Object({
		path: Type.String({ description: "Root directory" }),
		excludePatterns: Type.Optional(Type.Array(Type.String(), { description: "Glob patterns to exclude" })),
	}),
	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const resolved = resolvePath(params.path);
		if (!existsSync(resolved)) return { content: [{ type: "text", text: `Directory not found: ${resolved}` }], isError: true };
		const excludes = params.excludePatterns || [];
		function buildTree(dir: string, prefix: string): string[] {
			const lines: string[] = [];
			let entries: string[];
			try { entries = readdirSync(dir); } catch { return lines; }
			entries.sort((a, b) => {
				const aDir = statSync(join(dir, a)).isDirectory();
				const bDir = statSync(join(dir, b)).isDirectory();
				if (aDir !== bDir) return aDir ? -1 : 1;
				return a.localeCompare(b);
			});
			for (const entry of entries) {
				const full = join(dir, entry);
				try {
					const s = statSync(full);
					if (s.isDirectory()) {
						lines.push(`${prefix}[DIR] ${entry}`);
						lines.push(...buildTree(full, prefix + "  "));
					} else {
						lines.push(`${prefix}[FILE] ${entry}`);
					}
				} catch { }
			}
			return lines;
		}
		const tree = buildTree(resolved, "");
		return { content: [{ type: "text", text: tree.join("\n") || "(empty)" }] };
	},
});

const searchFilesTool = defineTool({
	name: "search_files",
	label: "Search Files",
	description: "Search for files matching a glob pattern recursively.",
	parameters: Type.Object({
		path: Type.String({ description: "Directory to search in" }),
		pattern: Type.String({ description: "Glob pattern (e.g. *.ts, **/*.json)" }),
		excludePatterns: Type.Optional(Type.Array(Type.String(), { description: "Patterns to exclude" })),
	}),
	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const resolved = resolvePath(params.path);
		if (!existsSync(resolved)) return { content: [{ type: "text", text: `Directory not found: ${resolved}` }], isError: true };
		const { glob } = await import("node:fs/promises");
		const { globSync } = await import("node:fs");
		let matches: string[] = [];
		try {
			const pattern = params.pattern.startsWith("**") ? params.pattern : `**/${params.pattern}`;
			const { globSync: gs } = await import("node:fs");
			const found = gs(pattern, { cwd: resolved, absolute: true });
			matches = found.slice(0, 200);
		} catch {
			return { content: [{ type: "text", text: "Glob not supported on this Node version" }], isError: true };
		}
		return { content: [{ type: "text", text: matches.join("\n") || "No matches found" }] };
	},
});

const getFileInfoTool = defineTool({
	name: "get_file_info",
	label: "Get File Info",
	description: "Get detailed metadata about a file or directory (size, timestamps, permissions).",
	parameters: Type.Object({
		path: Type.String({ description: "Path to inspect" }),
	}),
	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const resolved = resolvePath(params.path);
		if (!existsSync(resolved)) return { content: [{ type: "text", text: `Not found: ${resolved}` }], isError: true };
		const s = statSync(resolved);
		const info = {
			path: resolved,
			type: s.isDirectory() ? "directory" : s.isFile() ? "file" : "other",
			size: s.size,
			sizeFormatted: formatSize(s.size),
			created: s.birthtime?.toISOString(),
			modified: s.mtime.toISOString(),
			permissions: s.mode.toString(8).slice(-3),
		};
		return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
	},
});

const moveFileTool = defineTool({
	name: "move_file",
	label: "Move/Rename File",
	description: "Move or rename files and directories.",
	parameters: Type.Object({
		source: Type.String({ description: "Source path" }),
		destination: Type.String({ description: "Destination path" }),
	}),
	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const src = resolvePath(params.source);
		const dst = resolvePath(params.destination);
		if (!existsSync(src)) return { content: [{ type: "text", text: `Source not found: ${src}` }], isError: true };
		const dstDir = dirname(dst);
		if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true });
		renameSync(src, dst);
		return { content: [{ type: "text", text: `Moved ${src} -> ${dst}` }] };
	},
});

const readMediaFileTool = defineTool({
	name: "read_media_file",
	label: "Read Media File",
	description: "Read an image or audio file as base64. Returns base64 data and MIME type.",
	parameters: Type.Object({
		path: Type.String({ description: "Path to media file" }),
	}),
	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const resolved = resolvePath(params.path);
		if (!existsSync(resolved)) return { content: [{ type: "text", text: `File not found: ${resolved}` }], isError: true };
		const buf = readFileSync(resolved);
		const ext = extname(resolved).toLowerCase();
		const mimeMap: Record<string, string> = {
			".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
			".webp": "image/webp", ".svg": "image/svg+xml", ".mp3": "audio/mpeg", ".wav": "audio/wav",
		};
		const mime = mimeMap[ext] || "application/octet-stream";
		return { content: [{ type: "text", text: JSON.stringify({ mime, base64: buf.toString("base64"), size: buf.length }) }] };
	},
});

const readLinesTool = defineTool({
	name: "read_lines",
	label: "Read Lines",
	description: "Read specific line range from a file. Returns line-numbered output. 1-indexed.",
	parameters: Type.Object({
		path: Type.String({ description: "Path to the file" }),
		start: Type.Number({ description: "Start line (1-indexed)" }),
		end: Type.Optional(Type.Number({ description: "End line inclusive. Omit for single line." })),
	}),
	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const resolved = resolvePath(params.path);
		if (!existsSync(resolved)) return { content: [{ type: "text", text: `File not found: ${resolved}` }], isError: true };
		const lines = readFileSync(resolved, "utf-8").split("\n");
		const start = Math.max(1, params.start) - 1;
		const end = params.end !== undefined ? Math.min(params.end, lines.length) : start + 1;
		const selected = lines.slice(start, end).map((line, i) => `${start + i + 1}: ${line}`);
		return { content: [{ type: "text", text: selected.join("\n") }] };
	},
});

const replaceLinesTool = defineTool({
	name: "replace_lines",
	label: "Replace Lines",
	description: "Replace lines by line number range. 1-indexed. Set content to empty string to delete lines.",
	parameters: Type.Object({
		path: Type.String({ description: "Path to the file" }),
		start: Type.Number({ description: "Start line to replace (1-indexed)" }),
		end: Type.Number({ description: "End line to replace (1-indexed, inclusive)" }),
		content: Type.String({ description: "Replacement content. Empty string deletes the lines." }),
	}),
	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const resolved = resolvePath(params.path);
		if (!existsSync(resolved)) return { content: [{ type: "text", text: `File not found: ${resolved}` }], isError: true };
		const lines = readFileSync(resolved, "utf-8").split("\n");
		const start = Math.max(1, params.start) - 1;
		const end = Math.min(params.end, lines.length);
		const removed = lines.slice(start, end);
		const replacement = params.content ? params.content.split("\n") : [];
		lines.splice(start, end - start, ...replacement);
		writeFileSync(resolved, lines.join("\n"), "utf-8");
		return { content: [{ type: "text", text: `Replaced lines ${start + 1}-${end} (${removed.length} lines) with ${replacement.length} lines` }] };
	},
});

const insertLinesTool = defineTool({
	name: "insert_lines",
	label: "Insert Lines",
	description: "Insert content at a specific line number. 1-indexed. Existing lines shift down.",
	parameters: Type.Object({
		path: Type.String({ description: "Path to the file" }),
		after: Type.Number({ description: "Insert after this line number (0 for beginning)" }),
		content: Type.String({ description: "Content to insert" }),
	}),
	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const resolved = resolvePath(params.path);
		if (!existsSync(resolved)) return { content: [{ type: "text", text: `File not found: ${resolved}` }], isError: true };
		const lines = readFileSync(resolved, "utf-8").split("\n");
		const insertAt = Math.max(0, params.after);
		const newLines = params.content.split("\n");
		lines.splice(insertAt, 0, ...newLines);
		writeFileSync(resolved, lines.join("\n"), "utf-8");
		return { content: [{ type: "text", text: `Inserted ${newLines.length} lines after line ${insertAt}` }] };
	},
});

const appendFileTool = defineTool({
	name: "append_file",
	label: "Append to File",
	description: "Append content to a file. Creates the file if it doesn't exist.",
	parameters: Type.Object({
		path: Type.String({ description: "Path to the file" }),
		content: Type.String({ description: "Content to append" }),
	}),
	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const resolved = resolvePath(params.path);
		const dir = dirname(resolved);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		appendFileSync(resolved, params.content, "utf-8");
		return { content: [{ type: "text", text: `Appended ${params.content.length} bytes to ${resolved}` }] };
	},
});

const copyFileTool = defineTool({
	name: "copy_file",
	label: "Copy File",
	description: "Copy a file to a new location. Creates parent directories.",
	parameters: Type.Object({
		source: Type.String({ description: "Source file path" }),
		destination: Type.String({ description: "Destination file path" }),
	}),
	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const src = resolvePath(params.source);
		const dst = resolvePath(params.destination);
		if (!existsSync(src)) return { content: [{ type: "text", text: `Source not found: ${src}` }], isError: true };
		const dstDir = dirname(dst);
		if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true });
		copyFileSync(src, dst);
		return { content: [{ type: "text", text: `Copied ${src} -> ${dst}` }] };
	},
});

const deleteFileTool = defineTool({
	name: "delete_file",
	label: "Delete File/Dir",
	description: "Delete a file or directory. Use recursive for directories.",
	parameters: Type.Object({
		path: Type.String({ description: "Path to delete" }),
		recursive: Type.Optional(Type.Boolean({ description: "Delete directories recursively" })),
	}),
	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const resolved = resolvePath(params.path);
		if (!existsSync(resolved)) return { content: [{ type: "text", text: `Not found: ${resolved}` }], isError: true };
		const s = statSync(resolved);
		if (s.isDirectory()) {
			if (!params.recursive) return { content: [{ type: "text", text: `Is a directory. Set recursive: true to delete.` }], isError: true };
			rmSync(resolved, { recursive: true, force: true });
		} else {
			unlinkSync(resolved);
		}
		return { content: [{ type: "text", text: `Deleted: ${resolved}` }] };
	},
});

const findReplaceTool = defineTool({
	name: "find_replace",
	label: "Find & Replace (regex)",
	description: "Regex-based find and replace across a file. Supports all JS regex patterns and flags.",
	parameters: Type.Object({
		path: Type.String({ description: "Path to the file" }),
		find: Type.String({ description: "Regex pattern to find" }),
		replace: Type.String({ description: "Replacement string ($1, $2 for groups)" }),
		flags: Type.Optional(Type.String({ description: "Regex flags (default: g)" })),
		dryRun: Type.Optional(Type.Boolean({ description: "Preview changes without writing" })),
	}),
	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const resolved = resolvePath(params.path);
		if (!existsSync(resolved)) return { content: [{ type: "text", text: `File not found: ${resolved}` }], isError: true };
		const content = readFileSync(resolved, "utf-8");
		const regex = new RegExp(params.find, params.flags || "g");
		const matches = content.match(regex);
		const newContent = content.replace(regex, params.replace);
		if (!params.dryRun) writeFileSync(resolved, newContent, "utf-8");
		return { content: [{ type: "text", text: params.dryRun ? `Would replace ${matches?.length ?? 0} match(es)` : `Replaced ${matches?.length ?? 0} match(es) in ${resolved}` }] };
	},
});

const countLinesTool = defineTool({
	name: "count_lines",
	label: "Count Lines",
	description: "Get line count, word count, and byte size of a file.",
	parameters: Type.Object({
		path: Type.String({ description: "Path to the file" }),
	}),
	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const resolved = resolvePath(params.path);
		if (!existsSync(resolved)) return { content: [{ type: "text", text: `File not found: ${resolved}` }], isError: true };
		const content = readFileSync(resolved, "utf-8");
		const lines = content.split("\n").length;
		const words = content.split(/\s+/).filter(Boolean).length;
		const bytes = Buffer.byteLength(content, "utf-8");
		return { content: [{ type: "text", text: JSON.stringify({ lines, words, bytes, path: resolved }, null, 2) }] };
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(readTextFileTool);
	pi.registerTool(readMultipleFilesTool);
	pi.registerTool(readLinesTool);
	pi.registerTool(writeFileTool);
	pi.registerTool(editFileTool);
	pi.registerTool(replaceLinesTool);
	pi.registerTool(insertLinesTool);
	pi.registerTool(appendFileTool);
	pi.registerTool(findReplaceTool);
	pi.registerTool(createDirectoryTool);
	pi.registerTool(listDirectoryTool);
	pi.registerTool(listDirectoryWithSizesTool);
	pi.registerTool(directoryTreeTool);
	pi.registerTool(searchFilesTool);
	pi.registerTool(getFileInfoTool);
	pi.registerTool(moveFileTool);
	pi.registerTool(copyFileTool);
	pi.registerTool(deleteFileTool);
	pi.registerTool(countLinesTool);
	pi.registerTool(readMediaFileTool);
}
