/**
 * WLOC 设置写入脚本 (http-request)
 * 拦截 gs-loc.apple.com/wloc-settings/save 请求，把坐标写入引擎持久化存储。
 *
 * 支持三种操作 (通过 action 参数区分):
 *   ?lon=x&lat=y&acc=z  — 写入坐标 (默认)
 *   ?action=query        — 查询当前已保存的坐标
 *   ?action=clear        — 清除已保存的坐标 (清除后恢复真实位置)
 */
import { $app } from "./platform.mjs";
import { Console } from "./log.mjs";
import { done } from "./done.mjs";
import { getItem, setItem } from "./storage.mjs";
import { BOXJS_KEY } from "./config/index.mjs";

/** 引擎环境不一定有 URL 构造器，手工解析查询串 */
function parseQuery(url) {
	const queryString = url.split("?")[1] || "";
	const params = new Map();
	for (const pair of queryString.split("&")) {
		if (!pair) continue;
		const separator = pair.indexOf("=");
		const rawKey = separator === -1 ? pair : pair.slice(0, separator);
		const rawValue = separator === -1 ? "" : pair.slice(separator + 1);
		let key;
		let value;
		try {
			key = decodeURIComponent(rawKey.replace(/\+/g, " "));
		} catch {
			key = rawKey;
		}
		try {
			value = decodeURIComponent(rawValue.replace(/\+/g, " "));
		} catch {
			value = rawValue;
		}
		if (!params.has(key)) params.set(key, value);
	}
	return params;
}

/** 时间戳按东八区标注，方便与选点页面显示的时间对齐 */
function timestamp() {
	return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().replace("Z", "+08:00");
}

const url = $request.url || "";
const params = parseQuery(url);
const action = params.get("action") || "save";
let result;

Console.debug(`[wloc-settings] url=${url}, action=${action}`);

if (action === "query") {
	try {
		const stored = getItem(BOXJS_KEY);
		if (stored && typeof stored === "object" && stored.longitude && stored.latitude) {
			result = {
				success: true,
				longitude: stored.longitude,
				latitude: stored.latitude,
				accuracy: stored.accuracy || 25,
				updatedAt: stored.updatedAt || null,
			};
			Console.debug(`[wloc-settings] query: ${stored.longitude}, ${stored.latitude}`);
		} else {
			result = { success: false, error: "No saved coordinates" };
		}
	} catch (error) {
		result = { success: false, error: error.message || "read failed" };
	}
} else if (action === "clear") {
	try {
		setItem(BOXJS_KEY, null);
		result = { success: true };
		Console.info("[wloc-settings] Coordinate data cleared");
	} catch (error) {
		result = { success: false, error: error.message || "clear failed" };
		Console.error(`[wloc-settings] clear failed: ${error.message}`);
	}
} else {
	const longitude = parseFloat(params.get("lon") || params.get("longitude") || "0");
	const latitude = parseFloat(params.get("lat") || params.get("latitude") || "0");
	const accuracy = parseInt(params.get("acc") || params.get("accuracy") || "25", 10);
	if (longitude && latitude) {
		const data = { longitude, latitude, accuracy, updatedAt: timestamp() };
		try {
			if (setItem(BOXJS_KEY, data)) {
				result = { success: true, longitude, latitude, accuracy };
				Console.info(`[wloc-settings] saved: ${longitude}, ${latitude}`);
			} else {
				result = { success: false, error: "Storage.setItem returned false" };
				Console.error("[wloc-settings] setItem returned false");
			}
		} catch (error) {
			result = { success: false, error: error.message || "write failed" };
			Console.error(`[wloc-settings] ${error.message}`);
		}
	} else {
		result = { success: false, error: "missing lon/lat parameters" };
	}
}

const response = {
	status: 200,
	headers: {
		"Content-Type": "application/json",
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "GET, OPTIONS",
	},
	body: JSON.stringify(result),
};

// Quantumult X 的 script-echo-response 直接接收 {status, headers, body}
// 其余引擎的 http-request 需要 {response: {...}}
done($app === "Quantumult X" ? response : { response });
