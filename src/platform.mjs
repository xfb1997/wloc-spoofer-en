/**
 * 当前运行平台名称。
 * Name of the runtime that is executing the script.
 *
 * 识别顺序与各引擎注入的全局对象一一对应，命中即返回，全部落空时为 undefined。
 * Detection walks the globals each engine injects; undefined when nothing matches.
 */
export const $app = (() => {
	const has = (key) => key in globalThis;
	switch (true) {
		case has("$task"):
			return "Quantumult X";
		case has("$loon"):
			return "Loon";
		case has("$rocket"):
			return "Shadowrocket";
		case has("Egern"):
			return "Egern";
		case Boolean(globalThis.$environment?.["surge-version"]):
			return "Surge";
		case Boolean(globalThis.$environment?.["stash-version"]):
			return "Stash";
		case has("Cloudflare"):
			return "Worker";
		case Boolean(globalThis.process?.versions?.node):
			return "Node.js";
		default:
			return undefined;
	}
})();
