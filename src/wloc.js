/**
 * WLOC 位置改写脚本 (http-response)
 * 拦截 gs-loc.apple.com/clls/wloc 的响应体，改写其中的经纬度字段。
 *
 * 坐标来源优先级：选点页面/快捷指令写入的持久化数据 > 模块参数 > 默认值。
 * 默认值不写死坐标，经纬度留空时透传，即返回设备的真实网络位置。
 */
import { $argument } from "./argument.mjs";
import { $app } from "./platform.mjs";
import { Console } from "./log.mjs";
import { done } from "./done.mjs";
import { getItem } from "./storage.mjs";
import { ungzip } from "pako/lib/inflate.js";
import { BOXJS_KEY, DEFAULT_SETTINGS } from "./config/index.mjs";

/** 帧头之后、载荷之前的两字节长度字段 */
const FRAME_HEADER_SIZE = 10;

function readVarint(bytes, offset) {
	let value = 0;
	let multiplier = 1;
	let shift = 0;
	let position = offset;
	while (position < bytes.length) {
		const byte = bytes[position++] & 0xff;
		if (shift < 56) value += (byte & 0x7f) * multiplier;
		if (!(byte & 0x80)) return [value, position];
		multiplier *= 128;
		shift += 7;
		if (shift >= 70) throw new Error(`varint too long at ${position}`);
	}
	throw new Error("truncated varint");
}

/** 有符号 varint：负数按 64 位二进制补码编码为 10 字节 */
function writeVarint(value) {
	let integer = Math.floor(value);
	if (integer >= 0) {
		const bytes = [];
		while (integer >= 128) {
			bytes.push((integer % 128) | 128);
			integer = Math.floor(integer / 128);
		}
		bytes.push(integer);
		return bytes;
	}
	const words = [0, 0, 0, 0, 0, 0, 0, 0];
	let remaining = -integer;
	for (let index = 0; index < 8; index++) {
		words[index] = remaining & 255;
		remaining = Math.floor(remaining / 256);
	}
	let carry = 1;
	for (let index = 0; index < 8; index++) {
		const next = (~words[index] & 0xff) + carry;
		words[index] = next & 255;
		carry = next >> 8;
	}
	const bytes = [];
	for (let index = 0; index < 10; index++) {
		let chunk = 0;
		for (let bit = 0; bit < 7; bit++) {
			const position = index * 7 + bit;
			if (position < 64) chunk |= ((words[position >> 3] >> (position & 7)) & 1) << bit;
		}
		if (index < 9) chunk |= 128;
		bytes.push(chunk);
	}
	return bytes;
}

function concatBytes(chunks) {
	const bytes = [];
	for (const chunk of chunks) {
		for (let index = 0; index < chunk.length; index++) bytes.push(chunk[index] & 0xff);
	}
	return bytes;
}

function parseMessage(bytes) {
	const fields = [];
	let offset = 0;
	while (offset < bytes.length) {
		const start = offset;
		const [key, next] = readVarint(bytes, offset);
		offset = next;
		const fieldNo = Math.floor(key / 8);
		const wireType = key & 7;
		if (fieldNo === 0) throw new Error(`invalid protobuf field 0 at ${start}`);
		let value;
		if (wireType === 0) {
			const [varint, after] = readVarint(bytes, offset);
			value = varint;
			offset = after;
		} else if (wireType === 1) {
			value = bytes.slice(offset, offset + 8);
			offset += 8;
		} else if (wireType === 2) {
			const [length, after] = readVarint(bytes, offset);
			offset = after;
			value = bytes.slice(offset, offset + length);
			offset += length;
		} else if (wireType === 5) {
			value = bytes.slice(offset, offset + 4);
			offset += 4;
		} else {
			throw new Error(`unsupported wire type ${wireType}`);
		}
		fields.push({ fieldNo, wireType, value, raw: bytes.slice(start, offset) });
	}
	return fields;
}

function encodeField(fieldNo, wireType, value) {
	const key = writeVarint(fieldNo * 8 + wireType);
	if (wireType === 0) return concatBytes([key, writeVarint(value)]);
	if (wireType === 1 || wireType === 5) return concatBytes([key, value]);
	if (wireType === 2) return concatBytes([key, writeVarint(value.length), value]);
	throw new Error(`cannot encode wire type ${wireType}`);
}

function countChanges(stats, before) {
	return (
		stats.locations - before.locations +
		(stats.wifi - before.wifi) +
		(stats.cell - before.cell)
	);
}

function snapshotStats(stats) {
	return {
		wifi: stats.wifi || 0,
		cell: stats.cell || 0,
		locations: stats.locations || 0,
		skipped: stats.skipped || 0,
	};
}

function restoreStats(stats, snapshot) {
	stats.wifi = snapshot.wifi;
	stats.cell = snapshot.cell;
	stats.locations = snapshot.locations;
	stats.skipped = snapshot.skipped;
}

function bytesIdentical(a, b) {
	if (a.length !== b.length) return false;
	for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
	return true;
}

function fieldsIdentical(patched, original) {
	return patched.length === original.length && patched.join(",") === original.join(",");
}

/** 位置子消息：field 1 = 纬度, field 2 = 经度, field 3 = 精度，均为 1e8 定点整数 */
function patchLocation(bytes, target, stats) {
	const fields = parseMessage(bytes);
	let hasLatitude = false;
	let hasLongitude = false;
	for (const field of fields) {
		if (field.fieldNo === 1 && field.wireType === 0) hasLatitude = true;
		if (field.fieldNo === 2 && field.wireType === 0) hasLongitude = true;
	}
	if (!hasLatitude || !hasLongitude) return bytes;
	const chunks = [];
	for (const field of fields) {
		if (field.fieldNo === 1 && field.wireType === 0) {
			chunks.push(encodeField(1, 0, Math.round(target.latitude * 1e8)));
		} else if (field.fieldNo === 2 && field.wireType === 0) {
			chunks.push(encodeField(2, 0, Math.round(target.longitude * 1e8)));
		} else if (field.fieldNo === 3 && field.wireType === 0) {
			chunks.push(encodeField(3, 0, target.accuracy));
		} else {
			chunks.push(field.raw);
		}
	}
	stats.locations++;
	return concatBytes(chunks);
}

/** WiFi 测量块：必须带 MAC 地址字段才认为可改写 */
function patchWifi(bytes, target, stats) {
	const fields = parseMessage(bytes);
	let hasMac = false;
	for (const field of fields) {
		if (field.fieldNo === 1 && field.wireType === 2) {
			const text = Array.from(field.value).map((byte) => String.fromCharCode(byte & 0xff)).join("");
			hasMac = /^[0-9a-fA-F]{1,2}(:[0-9a-fA-F]{1,2}){5}$/.test(text);
		}
	}
	if (!hasMac) return bytes;
	let patched = false;
	const chunks = [];
	for (const field of fields) {
		if (field.fieldNo === 2 && field.wireType === 2) {
			try {
				const inner = patchLocation(field.value, target, stats);
				if (!fieldsIdentical(inner, field.value)) patched = true;
				chunks.push(encodeField(field.fieldNo, field.wireType, inner));
			} catch {
				stats.skipped++;
				chunks.push(field.raw);
			}
		} else {
			chunks.push(field.raw);
		}
	}
	if (patched) stats.wifi++;
	return concatBytes(chunks);
}

/** 基站测量块 */
function patchCell(bytes, target, stats) {
	const fields = parseMessage(bytes);
	let patched = false;
	const chunks = [];
	for (const field of fields) {
		if (field.fieldNo === 5 && field.wireType === 2) {
			try {
				const inner = patchLocation(field.value, target, stats);
				if (!fieldsIdentical(inner, field.value)) patched = true;
				chunks.push(encodeField(field.fieldNo, field.wireType, inner));
			} catch {
				stats.skipped++;
				chunks.push(field.raw);
			}
		} else {
			chunks.push(field.raw);
		}
	}
	if (patched) stats.cell++;
	return concatBytes(chunks);
}

function patchMessage(bytes, target, stats) {
	const fields = parseMessage(bytes);
	const chunks = [];
	for (const field of fields) {
		if (field.wireType === 2 && field.fieldNo === 2) {
			chunks.push(encodeField(field.fieldNo, field.wireType, patchWifi(field.value, target, stats)));
		} else if (field.wireType === 2 && (field.fieldNo === 22 || field.fieldNo === 24)) {
			chunks.push(encodeField(field.fieldNo, field.wireType, patchCell(field.value, target, stats)));
		} else {
			chunks.push(field.raw);
		}
	}
	return concatBytes(chunks);
}

/** 帧结构：8 字节头 + 2 字节大端长度 + 载荷 */
function patchFrame(bytes, base, target, stats) {
	if (bytes.length < base + FRAME_HEADER_SIZE) {
		throw new Error(`body too short: ${bytes.length}, base=${base}`);
	}
	const frameLength = ((bytes[base + 8] & 0xff) << 8) | (bytes[base + 9] & 0xff);
	if (frameLength <= 0) throw new Error(`invalid empty frame length at ${base}`);
	if (frameLength + base + FRAME_HEADER_SIZE > bytes.length) {
		throw new Error(`invalid frame length ${frameLength} at ${base} for ${bytes.length}`);
	}
	const header = bytes.slice(0, base + 8);
	const payload = bytes.slice(base + FRAME_HEADER_SIZE, base + FRAME_HEADER_SIZE + frameLength);
	const trailer = bytes.slice(base + FRAME_HEADER_SIZE + frameLength);
	const before = snapshotStats(stats);
	const patched = patchMessage(payload, target, stats);
	const changed = countChanges(stats, before);
	if (patched.length > 0xffff) throw new Error(`patched payload too large: ${patched.length}`);
	if (changed <= 0 || bytesIdentical(payload, patched)) {
		restoreStats(stats, before);
		throw new Error(`frame parsed but no patchable wloc payload at ${base}`);
	}
	return concatBytes([header, [(patched.length >> 8) & 255, patched.length & 255], patched, trailer]);
}

/** 逐字节偏移兜底：没有可信帧头时直接扫描 protobuf 消息 */
function patchRaw(bytes, target, stats) {
	const reasons = [];
	const limit = Math.min(256, bytes.length);
	for (let offset = 0; offset <= limit; offset++) {
		const before = snapshotStats(stats);
		try {
			const payload = bytes.slice(offset);
			const patched = patchMessage(payload, target, stats);
			if (countChanges(stats, before) > 0 && !bytesIdentical(payload, patched)) {
				return concatBytes([bytes.slice(0, offset), patched]);
			}
			restoreStats(stats, before);
		} catch (error) {
			restoreStats(stats, before);
			if (reasons.length < 6) reasons.push(`raw@${offset}:${error && error.message ? error.message : String(error)}`);
		}
	}
	throw new Error(`raw protobuf scan failed; ${reasons.join(" | ")}`);
}

function patchBody(bytes, target) {
	const stats = { wifi: 0, cell: 0, locations: 0, skipped: 0 };
	if (bytes.length < FRAME_HEADER_SIZE) throw new Error(`body too short: ${bytes.length}`);
	const reasons = [];
	const candidates = [0, 2, 4, 6, 8, 10, 12, 14, 16];
	const limit = Math.min(96, Math.max(0, bytes.length - FRAME_HEADER_SIZE));
	for (let offset = 0; offset <= limit; offset++) {
		if (candidates.indexOf(offset) < 0) candidates.push(offset);
	}
	for (const base of candidates) {
		const before = snapshotStats(stats);
		try {
			const data = patchFrame(bytes, base, target, stats);
			Console.info(`[wloc] patched at offset=${base} locations=${stats.locations} wifi=${stats.wifi} cell=${stats.cell} skipped=${stats.skipped}`);
			return { data, stats };
		} catch (error) {
			restoreStats(stats, before);
			if (reasons.length < 6) reasons.push(`@${base}:${error && error.message ? error.message : String(error)}`);
		}
	}
	try {
		const data = patchRaw(bytes, target, stats);
		Console.info(`[wloc] patched via raw fallback locations=${stats.locations} wifi=${stats.wifi} cell=${stats.cell} skipped=${stats.skipped}`);
		return { data, stats };
	} catch (error) {
		reasons.push(`raw:${error && error.message ? error.message : String(error)}`);
	}
	throw new Error(`no patchable wloc payload found; ${reasons.join(" | ")}`);
}

function isGzip(bytes) {
	return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** 各引擎的二进制响应体形态不一致：ArrayBuffer / TypedArray / 类数组 / 逐字节字符串 */
function toByteArray(body) {
	if (!body) return [];
	if (typeof ArrayBuffer !== "undefined") {
		if (body instanceof ArrayBuffer) return Array.prototype.slice.call(new Uint8Array(body));
		if (ArrayBuffer.isView && ArrayBuffer.isView(body)) {
			return Array.prototype.slice.call(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
		}
	}
	if (typeof body.length === "number" && typeof body !== "string") {
		const bytes = [];
		for (let index = 0; index < body.length; index++) bytes.push(body[index] & 0xff);
		return bytes;
	}
	if (typeof body === "string") {
		const bytes = [];
		for (let index = 0; index < body.length; index++) bytes.push(body.charCodeAt(index) & 0xff);
		return bytes;
	}
	return [];
}

async function handleResponse(request, response, settings) {
	const url = request.url || "";
	Console.group(`[wloc] Response ${url}`);
	try {
		let bytes = toByteArray(response.bodyBytes || response.rawBody || response.body);
		if (!bytes.length) {
			Console.warn("[wloc] no binary body, skipping");
			return response;
		}
		Console.debug(`[wloc] input length=${bytes.length} gzip=${isGzip(bytes)}`);
		if (!Number.isFinite(settings.longitude) || !Number.isFinite(settings.latitude)) {
			Console.info("[wloc] passthrough mode: no coordinates set, response unchanged (real location restored)");
			return response;
		}
		let decompressed = bytes;
		if (isGzip(bytes)) decompressed = Array.from(ungzip(new Uint8Array(bytes)));
		const { data, stats } = patchBody(decompressed, settings);
		const body = new Uint8Array(data);
		response.body = body;
		response.bodyBytes = body;
		response.rawBody = body;
		if (response.headers) {
			delete response.headers["Content-Encoding"];
			delete response.headers["content-encoding"];
			delete response.headers["Transfer-Encoding"];
			delete response.headers["transfer-encoding"];
			response.headers["Content-Length"] = String(body.length);
		}
		response.status = 200;
		response.statusCode = 200;
		Console.info(`[wloc] target coordinates: ${settings.longitude},${settings.latitude} accuracy=${settings.accuracy} patched=${stats.locations}`);
		return response;
	} catch (error) {
		Console.error(`[wloc] ${error.message || error}`);
		return response;
	} finally {
		Console.groupEnd();
	}
}

/**
 * 把模块参数或持久化值转成有限数字。
 * 空值、未替换的占位符（如 {longitude}）、脏数据一律按"未设置"处理，保持透传。
 */
function toNumber(value) {
	if (value === null || value === undefined || value === "") return null;
	const num = typeof value === "number" ? value : Number.parseFloat(String(value));
	return Number.isFinite(num) ? num : null;
}

function readPersisted() {
	try {
		const saved = getItem(BOXJS_KEY);
		if (saved && typeof saved === "object") return saved;
	} catch (error) {
		Console.debug(`[settings] failed to read persisted data: ${error.message}`);
	}
	return null;
}

function readSettings() {
	const args = $argument;
	const persisted = readPersisted();
	const settings = { ...DEFAULT_SETTINGS };
	// 经纬度默认留空，不写死任何城市：留空即透传设备的真实网络位置
	const argLongitude = toNumber(args.longitude);
	const argLatitude = toNumber(args.latitude);
	const argAccuracy = toNumber(args.accuracy);
	if (argLongitude !== null) settings.longitude = argLongitude;
	if (argLatitude !== null) settings.latitude = argLatitude;
	if (argAccuracy !== null) settings.accuracy = argAccuracy;
	if (args.logLevel) settings.logLevel = args.logLevel;
	if (args.LogLevel) settings.logLevel = args.LogLevel;
	if (persisted) {
		const savedLongitude = toNumber(persisted.longitude);
		const savedLatitude = toNumber(persisted.latitude);
		const savedAccuracy = toNumber(persisted.accuracy);
		if (savedLongitude !== null) settings.longitude = savedLongitude;
		if (savedLatitude !== null) settings.latitude = savedLatitude;
		if (savedAccuracy !== null) settings.accuracy = savedAccuracy;
		Console.info(`[settings] using saved coordinates: ${settings.longitude},${settings.latitude}`);
	}
	if (!Number.isFinite(settings.longitude) || !Number.isFinite(settings.latitude)) {
		Console.info("[settings] passthrough mode: no coordinates set, location response unchanged");
	} else {
		Console.debug(`[settings] lon=${settings.longitude} lat=${settings.latitude} acc=${settings.accuracy}`);
	}
	return settings;
}

function getResponseObject() {
	try {
		return typeof $response !== "undefined" ? $response : void 0;
	} catch {
		return void 0;
	}
}

let result;
(async () => {
	const response = getResponseObject();
	if (!response) {
		Console.warn("[wloc] not response mode, skipping");
		return;
	}
	const settings = readSettings();
	Console.logLevel = settings.logLevel;
	result = await handleResponse($request, response, settings);
})()
	.catch((error) => Console.error(error))
	.finally(() => {
		switch (typeof result) {
			case "object": {
				if (result.headers?.["Content-Encoding"]) result.headers["Content-Encoding"] = "identity";
				if (result.headers?.["content-encoding"]) result.headers["content-encoding"] = "identity";
				if ($app === "Quantumult X") {
					if (!result.status) result.status = 200;
					delete result.headers?.["Content-Length"];
					delete result.headers?.["content-length"];
					delete result.headers?.["Transfer-Encoding"];
					done(result);
				} else {
					done({ response: result });
				}
				break;
			}
			case "undefined":
				done({});
				break;
			default:
				Console.error("[wloc] invalid response type: " + typeof result);
				done({});
		}
	});
