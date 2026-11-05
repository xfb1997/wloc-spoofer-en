import { $app } from "./platform.mjs";

// 只在无法识别的环境里兜底，脚本平台一律走各自的持久化接口。
const memory = {};

/**
 * 读取并反序列化。
 * Read a key and parse the stored JSON, falling back when nothing is stored.
 */
export function getItem(key, fallback = null) {
	let value = fallback;
	switch ($app) {
		case "Surge":
		case "Loon":
		case "Stash":
		case "Egern":
		case "Shadowrocket":
			value = $persistentStore.read(key);
			break;
		case "Quantumult X":
			value = $prefs.valueForKey(key);
			break;
		default:
			value = memory[key] ?? null;
			break;
	}
	try {
		value = JSON.parse(value);
	} catch {
		// 存的是非 JSON 文本时原样返回
	}
	return value ?? fallback;
}

/**
 * 序列化后写入，对象会被转成 JSON 文本。
 * Write a value; objects are stringified, so setItem(key, null) stores the text "null".
 */
export function setItem(key, value) {
	const payload = typeof value === "object" ? JSON.stringify(value) : String(value);
	switch ($app) {
		case "Surge":
		case "Loon":
		case "Stash":
		case "Egern":
		case "Shadowrocket":
			return $persistentStore.write(payload, key);
		case "Quantumult X":
			return $prefs.setValueForKey(payload, key);
		case "Worker":
			memory[key] = payload;
			return true;
		default:
			return false;
	}
}
