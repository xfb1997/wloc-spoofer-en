import { Console } from "./log.mjs";

// 引擎把参数当普通文本传进来，百分号与加号都要还原。
function decode(text) {
	const normalized = text.replace(/\+/g, " ");
	try {
		return decodeURIComponent(normalized);
	} catch {
		// 非法转义序列（例如单独的 %）保留原文，避免整段参数解析失败
		return normalized;
	}
}

/**
 * 把 `$argument` 归一化成对象。
 * Normalize the raw `$argument` global into a plain object.
 *
 * - 文本形态按 `key=value&key=value` 拆分，只按首个等号切分。
 * - 已经是对象时直接浅拷贝，缺失或非文本时得到空对象。
 * - 只支持扁平键名；本项目只读取 longitude / latitude / accuracy / logLevel。
 */
export function parseArgument(input) {
	const parsed = {};
	switch (typeof input) {
		case "string": {
			const query = input.replace(/^\?/, "");
			if (!query) break;
			for (const pair of query.split("&")) {
				if (!pair) continue;
				const [rawKey = "", rawValue = ""] = pair.split("=", 2);
				parsed[decode(rawKey).replace(/\[([^\[\]]+)\]/g, ".$1")] = decode(rawValue).replace(/"/g, "");
			}
			break;
		}
		case "object":
			if (input) for (const key of Object.keys(input)) parsed[key] = input[key];
			break;
		default:
			break;
	}
	return parsed;
}

// 写回 globalThis，让引擎侧的调试面板看到的也是归一化后的结果。
globalThis.$argument = parseArgument(globalThis.$argument);

// 大写 LogLevel 是旧写法，优先级高于模块内的默认值。
if (globalThis.$argument.LogLevel) Console.logLevel = globalThis.$argument.LogLevel;

export const $argument = globalThis.$argument;
