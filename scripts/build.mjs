/**
 * 构建 dist/ 下的引擎脚本。
 * 产物为单文件、无 import/export 的压缩脚本，可直接被 QX / Surge / Loon / Stash / Shadowrocket 加载。
 * 运行时依赖只有 pako 的解压部分，日志、平台识别、持久化与 done 均在 src/ 自有模块里。
 *
 * 用法: npm run build
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const targets = [
	{ entry: "src/wloc.js", out: "dist/wloc.js" },
	{ entry: "src/wloc-settings.js", out: "dist/wloc-settings.js" },
];

function buildStamp() {
	const now = new Date();
	const pad = (value) => String(value).padStart(2, "0");
	return [
		`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
		`${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
	].join(" ");
}

const stamp = buildStamp();

for (const target of targets) {
	const outfile = path.join(root, target.out);
	const basename = path.basename(target.out);
	await esbuild.build({
		entryPoints: [path.join(root, target.entry)],
		outfile,
		bundle: true,
		minify: true,
		format: "esm",
		target: ["es2022"],
		platform: "neutral",
	legalComments: "none",
	charset: "ascii",
		banner: { js: `/* ${basename} - Build ${stamp} */` },
	});
	console.log(`built ${target.out} (${stamp})`);
}
