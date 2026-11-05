import { $app } from "./platform.mjs";

// 级别标记位保留一个空格，不带 emoji：与 dist/ 既有产物的日志排版逐字符一致，
// 也方便在引擎控制台里直接搜索 "[wloc] "。
export const MARK = " ";
const GROUP_INDENT = "  ";
const LEVEL_NAMES = ["OFF", "ERROR", "WARN", "INFO", "DEBUG", "ALL"];
const LEVEL_VALUES = { off: 0, error: 1, warn: 2, warning: 2, info: 3, debug: 4, all: 5 };

/**
 * 引擎控制台日志。
 * Logging helper shared by both engine scripts.
 *
 * 行为约定:
 * - 级别为 OFF 时完全静默；debug 需要 DEBUG 及以上，info 需要 INFO 及以上。
 * - group 内的每条消息缩进两级，分组标题独占一行并以冒号结尾。
 * - 多行字符串按行拆开，对象按 JSON 打印。
 */
export class Console {
	static #groups = [];
	static #level = 3;

	static get logLevel() {
		return LEVEL_NAMES[Console.#level] ?? "INFO";
	}

	static set logLevel(level) {
		switch (typeof level) {
			case "string":
				level = level.toLowerCase();
				break;
			case "number":
				break;
			case "undefined":
			default:
				level = "warn";
				break;
		}
		Console.#level = LEVEL_VALUES[level] ?? 2;
	}

	static log = (...msg) => {
		if (Console.#level === 0) return;
		msg = msg.flatMap((item) => {
			switch (typeof item) {
				case "object":
					return [JSON.stringify(item)];
				case "bigint":
				case "number":
				case "boolean":
					return [item.toString()];
				case "string":
					return item.split(/\r?\n/u);
				default:
					return [item];
			}
		});
		Console.#groups.forEach((group) => {
			msg = msg.map((line) => `${GROUP_INDENT}${line}`);
			msg.unshift(`${MARK}${group}:`);
		});
		msg = ["", ...msg];
		console.log(msg.join("\n"));
	};

	static group = (label) => Console.#groups.unshift(label);

	static groupEnd = () => Console.#groups.shift();

	static info(...msg) {
		if (Console.#level < 3) return;
		Console.log(...msg.map((item) => `${MARK}${item}`));
	}

	static warn(...msg) {
		if (Console.#level < 2) return;
		Console.log(...msg.map((item) => `${MARK}${item}`));
	}

	static debug(...msg) {
		if (Console.#level < 4) return;
		Console.log(...msg.map((item) => `${MARK}${item}`));
	}

	// Worker / Node.js 下带上堆栈，脚本平台只打印消息本身。
	static error(...msg) {
		if (Console.#level < 1) return;
		switch ($app) {
			case "Worker":
			case "Node.js":
				Console.log(...msg.map((item) => `${MARK}${item?.stack ?? item}`));
				break;
			default:
				Console.log(...msg.map((item) => `${MARK}${item}`));
		}
	}
}
