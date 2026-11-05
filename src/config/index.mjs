/**
 * src 与选点页面 (worker)、快捷指令共享的常量。
 * Shared constants between the engine scripts, the picker page and the shortcuts.
 */

/** 坐标持久化键名，需与 box.dat / $persistentStore 中的键保持一致 */
export const BOXJS_KEY = "wloc_settings";

/**
 * 默认设置。
 * 经纬度默认为 null：不写死任何城市坐标，留空即透传设备的真实网络位置。
 */
export const DEFAULT_SETTINGS = {
	longitude: null,
	latitude: null,
	accuracy: 25,
	logLevel: "info",
};
