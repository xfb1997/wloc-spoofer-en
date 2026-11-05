/**
 * dist 行为校验。
 *
 * 做两件事:
 *   1. 把当前 dist 产物与 git 中已提交的产物放在同一批合成样本上对跑，逐项比对
 *      改写后的字节、返回给引擎的对象和脚本日志，确保重构源码没有改变行为。
 *   2. 校验默认坐标留空即透传真实位置这一新语义。
 *
 * 用法: npm run verify   (构建后校验: npm run check)
 */
import cp from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import zlib from "node:zlib";

const require = createRequire(import.meta.url);
const { TextDecoder, TextEncoder } = require("node:util");

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WLOC_URL = "https://gs-loc.apple.com/clls/wloc";
const SETTINGS_URL = "https://gs-loc.apple.com/wloc-settings/save";
const STORE_KEY = "wloc_settings";

/** 已确认的预期行为差异：默认坐标不再写死 */
const INTENDED_DIFFERENCE = "默认坐标不再写死为 113.94114/22.544577";

let failures = 0;
let comparisons = 0;

function fail(label, detail) {
	failures++;
	console.error(`FAIL ${label}\n${detail}`);
}

function ok(label) {
	comparisons++;
	console.log(`ok   ${label}`);
}

function assert(label, condition, detail = "") {
	if (condition) ok(label);
	else fail(label, detail);
}

// ── 合成 wloc 报文 ────────────────────────────────────────────────

function varint(value) {
	const bytes = [];
	let integer = Math.floor(value);
	while (integer >= 128) {
		bytes.push((integer % 128) | 128);
		integer = Math.floor(integer / 128);
	}
	bytes.push(integer);
	return bytes;
}

function fieldVarint(fieldNo, value) {
	return [...varint(fieldNo * 8), ...varint(value)];
}

function fieldBytes(fieldNo, value) {
	return [...varint(fieldNo * 8 + 2), ...varint(value.length), ...value];
}

function fieldText(fieldNo, text) {
	return fieldBytes(fieldNo, Array.from(text).map((char) => char.charCodeAt(0)));
}

function locationMessage({ latitude, longitude, accuracy }) {
	return [
		...fieldVarint(1, Math.round(latitude * 1e8)),
		...fieldVarint(2, Math.round(longitude * 1e8)),
		...fieldVarint(3, accuracy),
	];
}

function wifiBlock({ mac, locations }) {
	const parts = [];
	if (mac) parts.push(fieldText(1, mac));
	for (const location of locations) parts.push(fieldBytes(2, locationMessage(location)));
	parts.push(fieldBytes(4, [1, 2, 3, 4]));
	return parts.flat();
}

function cellBlock({ locations }) {
	const parts = [];
	for (const location of locations) parts.push(fieldBytes(5, locationMessage(location)));
	parts.push(fieldVarint(7, 12));
	return parts.flat();
}

function wlocPayload({ real, wifiCount = 1, mac = "aa:bb:cc:dd:ee:ff", cellCount = 1 }) {
	const parts = [];
	parts.push(fieldVarint(1, 4));
	for (let index = 0; index < wifiCount; index++) {
		parts.push(fieldBytes(2, wifiBlock({ mac: index === 0 ? mac : "", locations: [real, real] })));
	}
	for (let index = 0; index < cellCount; index++) {
		parts.push(fieldBytes(22, cellBlock({ locations: [real] })));
		parts.push(fieldBytes(24, cellBlock({ locations: [real] })));
	}
	return parts.flat();
}

/** 8 字节帧头 + 2 字节大端长度 + 载荷，可再加一段前置噪声模拟带前缀的响应 */
function wlocBody({ payload, preamble = [] }) {
	const frame = [...new Array(8).fill(0).map((_, index) => (index === 7 ? 1 : 0)), (payload.length >> 8) & 255, payload.length & 255, ...payload];
	return [...preamble, ...frame];
}

function readVarintValue(bytes, offset) {
	let value = 0;
	let shift = 0;
	while (offset < bytes.length) {
		const byte = bytes[offset++];
		value += (byte & 0x7f) * 2 ** shift;
		shift += 7;
		if (!(byte & 0x80)) return [value, offset];
	}
	throw new Error("truncated varint");
}

/** 独立实现的 protobuf 读取器，用于校验产物里的实际坐标 */
function readFields(bytes) {
	const fields = [];
	let offset = 0;
	while (offset < bytes.length) {
		let key;
		[key, offset] = readVarintValue(bytes, offset);
		const fieldNo = Math.floor(key / 8);
		const wireType = key % 8;
		if (wireType === 0) {
			let value;
			[value, offset] = readVarintValue(bytes, offset);
			fields.push({ fieldNo, wireType, value });
		} else if (wireType === 2) {
			let length;
			[length, offset] = readVarintValue(bytes, offset);
			fields.push({ fieldNo, wireType, value: bytes.slice(offset, offset + length) });
			offset += length;
		} else if (wireType === 5) {
			fields.push({ fieldNo, wireType, value: bytes.slice(offset, offset + 4) });
			offset += 4;
		} else if (wireType === 1) {
			fields.push({ fieldNo, wireType, value: bytes.slice(offset, offset + 8) });
			offset += 8;
		} else {
			return fields;
		}
	}
	return fields;
}

/** 从偏移 0 的帧里取第一个可改写位置消息的坐标 */
function decodeCoordinates(body) {
	if (!body || body.length < 10) return null;
	const frameLength = (body[8] << 8) | body[9];
	const payload = body.slice(10, 10 + frameLength);
	for (const wifi of readFields(payload)) {
		if (wifi.fieldNo !== 2 || wifi.wireType !== 2) continue;
		for (const location of readFields(wifi.value)) {
			if (location.fieldNo !== 2 || location.wireType !== 2) continue;
			const coords = {};
			for (const field of readFields(location.value)) {
				if (field.fieldNo === 1) coords.latitude = field.value / 1e8;
				if (field.fieldNo === 2) coords.longitude = field.value / 1e8;
				if (field.fieldNo === 3) coords.accuracy = field.value;
			}
			if (coords.latitude !== undefined && coords.longitude !== undefined) return coords;
		}
	}
	return null;
}

// ── 引擎沙箱 ─────────────────────────────────────────────────────

function engineGlobals(engine, store) {
	const globals = {};
	const persistent = {
		read: (key) => (key in store ? store[key] : null),
		write: (value, key) => {
			store[key] = value === null ? "null" : String(value);
			return true;
		},
	};
	const prefs = {
		valueForKey: (key) => (key in store ? store[key] : null),
		setValueForKey: (value, key) => {
			store[key] = value === null ? "null" : String(value);
			return true;
		},
		removeValueForKey: (key) => {
			delete store[key];
			return true;
		},
		removeAllValues: () => true,
	};
	switch (engine) {
		case "Quantumult X":
			globals.$task = { getLocalStorage: () => ({}), setLocalStorage: () => {}, postMessage: () => {} };
			globals.$prefs = prefs;
			break;
		case "Loon":
			globals.$loon = { postNotification: () => {}, isAutograb: () => false, version: () => "1.1.0", getScriptArgument: () => "" };
			globals.$persistentStore = persistent;
			break;
		default:
			globals.$environment = { "surge-version": "Surge 10.9.0 (2998)", "is-ios": true };
			globals.$persistentStore = persistent;
			break;
	}
	return globals;
}

function bodyExpression(kind) {
	switch (kind) {
		case "uint8":
			return "new Uint8Array(__bytes)";
		case "buffer":
			return "new Uint8Array(__bytes).buffer";
		case "string":
			return "String.fromCharCode.apply(null, __bytes)";
		case "none":
			return "undefined";
		default:
			return "__bytes";
	}
}

function tagOf(value) {
	return Object.prototype.toString.call(value);
}

const BINARY_TAGS = new Set(["[object ArrayBuffer]", "[object Uint8Array]", "[object Uint8ClampedArray]", "[object Int8Array]"]);

function normalize(value) {
	if (value === undefined) return null;
	if (BINARY_TAGS.has(tagOf(value))) {
		const view = value instanceof ArrayBuffer || tagOf(value) === "[object ArrayBuffer]" ? new Uint8Array(value) : value;
		return Array.from(view);
	}
	if (Array.isArray(value)) return value.map(normalize);
	if (typeof value === "function") return "[fn]";
	if (value && typeof value === "object") {
		const out = {};
		for (const key of Object.keys(value).sort()) out[key] = normalize(value[key]);
		return out;
	}
	return value;
}

async function runBundle(code, options) {
	const { engine = "Surge", argument, requestUrl = WLOC_URL, responseMode = true, bodyKind = "array", bytes = [], setup = "" } = options;
	// 每次运行拿持久化状态的独立副本，否则基线跑完会改写同一个对象，构建产物读到的是被污染的数据
	const store = JSON.parse(JSON.stringify(options.store ?? {}));
	const logs = [];
	const finished = [];
	const sandbox = {
		console: { log: (...parts) => logs.push(parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" ")) },
		$done: (payload) => finished.push(payload),
		$script: { startTime: Date.now() },
		TextEncoder,
		TextDecoder,
		...engineGlobals(engine, store),
	};
	if (argument !== undefined) sandbox.$argument = argument;
	const context = vm.createContext(sandbox);
	vm.runInContext(
		`globalThis.__bytes = ${JSON.stringify(bytes)};\n` +
			`globalThis.$request = { url: ${JSON.stringify(requestUrl)}, method: "GET", headers: {} };\n` +
			(responseMode ? `globalThis.$response = { status: 200, headers: { "Content-Type": "application/octet-stream" }, bodyBytes: ${bodyExpression(bodyKind)} };\n` : "") +
			setup,
		context,
		{ filename: "setup.js" },
	);
	vm.runInContext(code, context, { filename: "bundle.js" });
	await new Promise((resolve) => setTimeout(resolve, 40));
	return {
		logs: logs.filter((line) => line.includes("[wloc]") || line.includes("[settings]")).map((line) => line.trim()),
		done: finished.map((payload) => normalize(payload)),
		store,
	};
}

function readCommitted(relPath) {
	try {
		return cp.execSync(`git show HEAD:${relPath}`, { cwd: root, maxBuffer: 16 * 1024 * 1024 }).toString("utf8");
	} catch {
		return null;
	}
}

function readDist(relPath) {
	return fs.readFileSync(path.join(root, relPath), "utf8");
}

// 字节数组很长，直接打印 JSON 会淹没真正的差异，这里只定位到首个不一致的位置
function firstDiffPath(a, b, trail = []) {
	if (a === b) return null;
	const tagA = tagOf(a);
	const tagB = tagOf(b);
	if (tagA !== tagB) return { path: trail.join(".") || "<root>", detail: `类型不同 ${tagA} / ${tagB}` };
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return { path: trail.join(".") || "<root>", detail: `长度不同 ${a.length} / ${b.length}` };
		for (let index = 0; index < a.length; index += 1) {
			const found = firstDiffPath(a[index], b[index], [...trail, index]);
			if (found) return found;
		}
		return null;
	}
	if (a && typeof a === "object") {
		const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)])).sort();
		for (const key of keys) {
			const found = firstDiffPath(a[key], b[key], [...trail, key]);
			if (found) return found;
		}
		return null;
	}
	return { path: trail.join(".") || "<root>", detail: `${JSON.stringify(a)} / ${JSON.stringify(b)}` };
}

function contextAround(value, path, width = 10) {
	const parts = String(path).split(".").filter(Boolean);
	let cursor = value;
	for (const part of parts) {
		if (cursor == null) return null;
		cursor = cursor[part];
	}
	if (!Array.isArray(cursor)) return JSON.stringify(cursor);
	const index = Number(parts[parts.length - 1]);
	const from = Math.max(0, index - width);
	return `[${from}..${Math.min(cursor.length - 1, index + width)}] ${JSON.stringify(cursor.slice(from, index + width + 1))}`;
}

function diffText(a, b) {
	const lines = [];
	const logA = a.logs ?? [];
	const logB = b.logs ?? [];
	if (JSON.stringify(logA) !== JSON.stringify(logB)) {
		lines.push("日志不一致:");
		const max = Math.max(logA.length, logB.length);
		for (let index = 0; index < max; index += 1) {
			if (logA[index] !== logB[index]) {
				lines.push(`  [${index}] committed: ${logA[index] ?? "<无>"}`);
				lines.push(`  [${index}] built:     ${logB[index] ?? "<无>"}`);
			}
		}
	}
	const first = firstDiffPath(a, b);
	if (first) {
		lines.push(`首个差异 ${first.path}: ${first.detail}`);
		lines.push(`  committed ${contextAround(a, first.path) ?? "-"}`);
		lines.push(`  built     ${contextAround(b, first.path) ?? "-"}`);
	}
	if (!lines.length) lines.push("仅序列化顺序差异", JSON.stringify(a), JSON.stringify(b));
	return lines.join("\n");
}

// ── 1. 结构检查 ──────────────────────────────────────────────────

const bundles = ["dist/wloc.js", "dist/wloc-settings.js"];
const built = {};
const committed = {};

for (const relPath of bundles) {
	const name = path.basename(relPath);
	const code = readDist(relPath);
	built[name] = code;
	committed[name] = readCommitted(relPath);
	assert(`${name}: 构建横幅`, code.startsWith(`/* ${name} - Build `));
	assert(`${name}: 无 import/export 残留`, !/^\s*(import|export)[\s{*]/m.test(code.split("\n").slice(1).join("\n")));
	// 设置脚本只读 URL 查询串，不碰 $argument
	if (name === "wloc.js") assert(`${name}: 参数解析已内联`, code.includes("globalThis.$argument"));
	if (committed[name] === null) console.log(`note ${name}: 未取到 git 基线，跳过对跑`);
}

// ── 2. wloc.js 对跑 ─────────────────────────────────────────────

// 报文里的“真实位置”刻意取北京，避免与旧的写死默认值（珠海）撞值导致改写变成空操作
const REAL = { latitude: 39.9042, longitude: 116.39747, accuracy: 25 };
const TARGET = { latitude: 30.274084, longitude: 120.15507, accuracy: 30 };
const DEFAULT_ARGS = "longitude=113.94114&latitude=22.544577&accuracy=25&logLevel=info";
const SAVED = { longitude: String(TARGET.longitude), latitude: String(TARGET.latitude), accuracy: "40", updatedAt: "2026-01-01T00:00:00.000+08:00" };

const plainBody = wlocBody({ payload: wlocPayload({ real: REAL }) });
const preambleBody = wlocBody({ payload: wlocPayload({ real: REAL }), preamble: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
const gzipBody = Array.from(zlib.gzipSync(Buffer.from(plainBody)));
const junkBody = Array.from({ length: 80 }, (_, index) => (index * 37 + 11) % 251);

const wlocCases = [
	{ label: "帧偏移 0 + 已保存坐标", bytes: plainBody, store: { [STORE_KEY]: JSON.stringify(SAVED) } },
	{ label: "帧偏移 12 + 已保存坐标", bytes: preambleBody, store: { [STORE_KEY]: JSON.stringify(SAVED) } },
	{ label: "gzip 压缩响应", bytes: gzipBody, store: { [STORE_KEY]: JSON.stringify(SAVED) } },
	// 以下几类是“默认坐标不写死”带来的预期差异，其余必须与已提交产物完全一致
	{ label: "仅模块参数", bytes: plainBody, argument: "longitude=100.500000&latitude=30.500000&accuracy=50&logLevel=info" },
	// 模块参数恰好等于旧的写死默认值时，旧产物判定为“用户没改过”而透传，新语义视为手动坐标照写
	{ label: "参数等于旧写死默认值", bytes: plainBody, argument: DEFAULT_ARGS, diverges: true },
	{ label: "参数与已保存坐标并存", bytes: plainBody, argument: DEFAULT_ARGS, store: { [STORE_KEY]: JSON.stringify(SAVED) } },
	{ label: "参数为对象形态", bytes: plainBody, argument: { longitude: "121.4737", latitude: "31.2304", accuracy: "20" } },
	{ label: "参数留空", bytes: plainBody, argument: "longitude=&latitude=&accuracy=25&logLevel=info" },
	{ label: "占位符未被替换", bytes: plainBody, argument: "longitude={longitude}&latitude={latitude}&accuracy=25", diverges: true },
	{ label: "参数非法值", bytes: plainBody, argument: "longitude=abc&latitude=def", diverges: true },
	{ label: "持久化数据为空对象", bytes: plainBody, argument: DEFAULT_ARGS, store: { [STORE_KEY]: "{}" } },
	{ label: "持久化数据为 null", bytes: plainBody, argument: DEFAULT_ARGS, store: { [STORE_KEY]: "null" }, diverges: true },
	{ label: "无参数无持久化", bytes: plainBody },
	{ label: "缺少经纬度字段", bytes: plainBody, store: { [STORE_KEY]: JSON.stringify({ accuracy: 25 }) } },
	{ label: "不可改写的报文", bytes: junkBody, store: { [STORE_KEY]: JSON.stringify(SAVED) } },
	{ label: "空响应体", bytes: [], store: { [STORE_KEY]: JSON.stringify(SAVED) } },
	{ label: "超短响应体", bytes: [1, 2, 3], store: { [STORE_KEY]: JSON.stringify(SAVED) } },
];

const engines = ["Surge", "Quantumult X", "Loon"];
const bodyKinds = ["array", "uint8", "buffer", "string"];

for (const engine of engines) {
	for (const bodyKind of bodyKinds) {
		for (const testCase of wlocCases) {
			const label = `${engine}/${bodyKind}/${testCase.label}`;
			const options = { engine, bodyKind, ...testCase };
			const current = await runBundle(built["wloc.js"], options);
			if (committed["wloc.js"] === null) break;
			const baseline = await runBundle(committed["wloc.js"], options);
			const same = JSON.stringify(current) === JSON.stringify(baseline);
			if (same) ok(`${label} 一致`);
			else if (testCase.diverges) ok(`${label} 差异符合预期 (${INTENDED_DIFFERENCE})`);
			else fail(label, diffText(baseline, current));
		}
	}
}

// ── 3. 新语义断言：默认位置 = 当前位置 ──────────────────────────

const passthrough = await runBundle(built["wloc.js"], { engine: "Surge", bytes: plainBody });
assert("空参数即透传真实位置", JSON.stringify(passthrough.done[0].response.bodyBytes) === JSON.stringify(plainBody), JSON.stringify(passthrough.done));
assert("透传日志提示真实位置", passthrough.logs.some((line) => line.includes("passthrough mode")), JSON.stringify(passthrough.logs));

const manualOverride = await runBundle(built["wloc.js"], { engine: "Surge", bytes: plainBody, argument: "longitude=100.500000&latitude=30.500000" });
const manualCoords = decodeCoordinates(manualOverride.done[0].response.bodyBytes);
assert("手动填写的坐标一定生效", manualCoords && Math.abs(manualCoords.longitude - 100.5) < 1e-6 && Math.abs(manualCoords.latitude - 30.5) < 1e-6, JSON.stringify(manualCoords));

// 旧产物把“参数等于写死默认值”当成用户未修改，直接透传；新语义下这是用户明确要求的位置
const legacySentinel = await runBundle(built["wloc.js"], { engine: "Surge", bytes: plainBody, argument: DEFAULT_ARGS });
assert("写死默认值不再是透传信号", JSON.stringify(legacySentinel.done[0].response.bodyBytes) !== JSON.stringify(plainBody), JSON.stringify(legacySentinel.logs));

const savedWins = await runBundle(built["wloc.js"], { engine: "Surge", bytes: plainBody, argument: "longitude=1.5&latitude=2.5", store: { [STORE_KEY]: JSON.stringify(SAVED) } });
const savedCoords = decodeCoordinates(savedWins.done[0].response.bodyBytes);
assert("选点页面保存的坐标优先", savedCoords && Math.abs(savedCoords.longitude - TARGET.longitude) < 1e-6, JSON.stringify(savedCoords));
assert("保存的精度一并写入", savedCoords && savedCoords.accuracy === 40, JSON.stringify(savedCoords));

const argCoords = await runBundle(built["wloc.js"], { engine: "Surge", bytes: plainBody, argument: "longitude=121.473700&latitude=31.230400&accuracy=50" });
const argOnly = decodeCoordinates(argCoords.done[0].response.bodyBytes);
assert("模块参数坐标被写入报文", argOnly && Math.abs(argOnly.latitude - 31.2304) < 1e-6 && Math.abs(argOnly.longitude - 121.4737) < 1e-6, JSON.stringify(argOnly));

const placeholder = await runBundle(built["wloc.js"], { engine: "Surge", bytes: plainBody, argument: "longitude={longitude}&latitude={latitude}" });
assert("未替换的占位符按透传处理", JSON.stringify(placeholder.done[0].response.bodyBytes) === JSON.stringify(plainBody), JSON.stringify(placeholder.done));

const cleared = await runBundle(built["wloc.js"], { engine: "Surge", bytes: plainBody, argument: "longitude=&latitude=&accuracy=25&logLevel=info", store: { [STORE_KEY]: "null" } });
assert("清除保存的坐标后恢复真实位置", JSON.stringify(cleared.done[0].response.bodyBytes) === JSON.stringify(plainBody), JSON.stringify(cleared.done));

const notResponseMode = await runBundle(built["wloc.js"], { engine: "Surge", responseMode: false, bytes: plainBody });
assert("非响应模式下安全退出", notResponseMode.done.length === 1 && JSON.stringify(notResponseMode.done[0]) === "{}", JSON.stringify(notResponseMode));

// ── 3b. 模块配置与文档不再写死坐标 ──────────────────────────────

const configFiles = [
	"modules/wloc.lpx",
	"modules/wloc.module",
	"modules/wloc.sgmodule",
	"modules/wloc.stoverride",
	"modules/wloc.conf",
	"README.md",
	"README.en.md",
	"worker/src/page.js",
	"worker/wloc-worker.js",
	"src/config/index.mjs",
];
for (const relPath of configFiles) {
	const text = fs.readFileSync(path.join(root, relPath), "utf8");
	assert(`${relPath} 不含写死坐标`, !/113\.94114|22\.544577/.test(text), "");
}
// Loon 的 [Argument] 需要 k=v&k=v 形态才会被 parseArgument 解析
const lpx = fs.readFileSync(path.join(root, "modules/wloc.lpx"), "utf8");
assert("Loon argument 使用键值形态", /argument=longitude=\{longitude\}&latitude=\{latitude\}&accuracy=\{accuracy\}&logLevel=\{logLevel\}/.test(lpx), lpx.split("\n").find((line) => line.includes("argument=")) || "");
assert("Surge 脚本参数形态一致", /\{longitude\}/.test(fs.readFileSync(path.join(root, "modules/wloc.sgmodule"), "utf8")), "");

// ── 4. wloc-settings.js 对跑 ────────────────────────────────────

const settingsCases = [
	{ label: "保存坐标", url: `${SETTINGS_URL}?lon=120.15507&lat=30.274084&acc=40` },
	{ label: "默认精度", url: `${SETTINGS_URL}?lon=120.15507&lat=30.274084` },
	{ label: "参数名别名", url: `${SETTINGS_URL}?longitude=120.15507&latitude=30.274084&accuracy=60` },
	{ label: "缺少坐标", url: `${SETTINGS_URL}?action=save` },
	{ label: "只有经度", url: `${SETTINGS_URL}?lon=120.15507` },
	{ label: "零值坐标", url: `${SETTINGS_URL}?lon=0&lat=0` },
	{ label: "非法坐标", url: `${SETTINGS_URL}?lon=abc&lat=def` },
	{ label: "百分号编码", url: `${SETTINGS_URL}?lon=120.15507&lat=30.274084&acc=40&note=%E6%9D%AD%E5%B7%9E` },
	{ label: "加号编码", url: `${SETTINGS_URL}?lon=120.15507&lat=+30.274084` },
	{ label: "重复参数", url: `${SETTINGS_URL}?lon=1.1&lon=2.2&lat=3.3` },
	{ label: "无查询串", url: SETTINGS_URL },
	{ label: "查询已保存", url: `${SETTINGS_URL}?action=query`, store: { [STORE_KEY]: JSON.stringify(SAVED) } },
	{ label: "查询空数据", url: `${SETTINGS_URL}?action=query` },
	{ label: "清除数据", url: `${SETTINGS_URL}?action=clear`, store: { [STORE_KEY]: JSON.stringify(SAVED) } },
	{ label: "损坏的持久化数据", url: `${SETTINGS_URL}?action=query`, store: { [STORE_KEY]: "{not json" } },
];

for (const engine of engines) {
	for (const testCase of settingsCases) {
		const label = `${engine}/settings/${testCase.label}`;
		const options = { engine, requestUrl: testCase.url, store: { ...(testCase.store || {}) }, bytes: plainBody };
		const current = await runBundle(built["wloc-settings.js"], options);
		if (committed["wloc-settings.js"] === null) break;
		const baseline = await runBundle(committed["wloc-settings.js"], options);
		const currentJson = JSON.stringify(current);
		const baselineJson = JSON.stringify(baseline);
		if (currentJson === baselineJson) ok(`${label} 一致`);
		else {
	// 时间戳本身随构建时间变化，剔除后再次比对（含持久化字符串里的转义引号形态）
	const scrub = (text) =>
		text
			.replace(/\\?"updatedAt\\?":\\?"[^"]*?\\?"/g, '"updatedAt":"~"')
			.replace(/updatedAt=[^&"]*/g, "updatedAt=~");
			if (scrub(currentJson) === scrub(baselineJson)) ok(`${label} 一致 (仅时间戳不同)`);
			else fail(label, diffText(JSON.parse(scrub(baselineJson)), JSON.parse(scrub(currentJson))));
		}
		const written = current.store[STORE_KEY];
		if (testCase.label === "保存坐标") {
			const parsed = written ? JSON.parse(written) : null;
			assert(`${label}: 写入内容`, parsed && parsed.longitude === 120.15507 && parsed.latitude === 30.274084 && parsed.accuracy === 40, String(written));
			assert(`${label}: 东八区时间戳`, /\+08:00$/.test(parsed.updatedAt), String(written));
		}
	}
}

console.log(`\n${failures ? "FAILED" : "ALL CHECKS PASSED"} (${comparisons} checks, ${failures} failures)`);
process.exit(failures ? 1 : 0);
