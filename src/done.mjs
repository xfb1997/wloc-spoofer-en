import { $app } from "./platform.mjs";
import { Console, MARK } from "./log.mjs";
import { StatusTexts } from "./status-texts.mjs";

function pick(object, keys) {
	const picked = {};
	for (const key of keys) if (key in object) picked[key] = object[key];
	return picked;
}

function setPath(object, path, value) {
	const keys = path.split(".");
	let cursor = object;
	for (const key of keys.slice(0, -1)) {
		if (typeof cursor[key] !== "object" || cursor[key] === null) cursor[key] = {};
		cursor = cursor[key];
	}
	cursor[keys[keys.length - 1]] = value;
}

/**
 * 结束脚本执行，并按平台转换出参。
 * Finish the script run, mapping the payload onto each engine's `$done` shape.
 *
 * - Quantumult X 只认识 status / url / headers / body / bodyBytes，状态码要展开成状态行。
 * - Surge、Loon、Stash 用请求头或 node 字段表达指定策略。
 * - 未识别环境只补一条结束日志。
 */
export function done(object = {}) {
	switch ($app) {
		case "Surge":
			if (object.policy) setPath(object, "headers.X-Surge-Policy", object.policy);
			Console.log(`${MARK}Done!`, `${MARK}${new Date().getTime() / 1000 - $script.startTime} sec`);
			$done(object);
			break;
		case "Loon":
			if (object.policy) object.node = object.policy;
			Console.log(`${MARK}Done!`, `${MARK}${(new Date() - $script.startTime) / 1000} sec`);
			$done(object);
			break;
		case "Stash":
			if (object.policy) setPath(object, "headers.X-Stash-Selected-Proxy", encodeURI(object.policy));
			Console.log(`${MARK}Done!`, `${MARK}${(new Date() - $script.startTime) / 1000} sec`);
			$done(object);
			break;
		case "Egern":
		case "Shadowrocket":
			Console.log(`${MARK}Done!`);
			$done(object);
			break;
		case "Quantumult X":
			if (object.policy) setPath(object, "opts.policy", object.policy);
			object = pick(object, ["status", "url", "headers", "body", "bodyBytes"]);
			switch (typeof object.status) {
				case "number":
					object.status = `HTTP/1.1 ${object.status} ${StatusTexts[object.status]}`;
					break;
				case "string":
				case "undefined":
					break;
				default:
					throw new TypeError(`${Function.name}: parameter type error, status must be a number or string`);
			}
			if (object.body instanceof ArrayBuffer) {
				object.bodyBytes = object.body;
				object.body = undefined;
			} else if (ArrayBuffer.isView(object.body)) {
				object.bodyBytes = object.body.buffer.slice(object.body.byteOffset, object.body.byteLength + object.body.byteOffset);
				object.body = undefined;
			} else if (object.body) object.bodyBytes = undefined;
			Console.log(`${MARK}Done!`);
			$done(object);
			break;
		case "Node.js":
			Console.log(`${MARK}Done!`);
			process.exit(1);
			break;
		case "Worker":
		default:
			Console.log(`${MARK}Done!`);
			break;
	}
}
