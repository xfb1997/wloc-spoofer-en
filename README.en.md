<p align="center">
  <img src="wloc.jpg" width="144" />
</p>

<p align="center">
  <a href="README.md">简体中文</a> ·
  <a href="README.en.md"><b>English</b></a>
</p>

# Apple WLOC Location Spoofer

Modify the coordinates returned by Apple's network-based location service (WiFi/cell) to spoof iOS network location. Open the online picker page, choose a spot, and it takes effect — no need to type latitude/longitude by hand.

---

## Subscription links

**Surge:**
https://raw.githubusercontent.com/xfb1997/wloc-spoofer-en/refs/heads/main/modules/wloc.sgmodule

**Quantumult X:**
https://raw.githubusercontent.com/xfb1997/wloc-spoofer-en/refs/heads/main/modules/wloc.conf

**Loon:**
https://raw.githubusercontent.com/xfb1997/wloc-spoofer-en/refs/heads/main/modules/wloc.lpx

**Stash:**
https://raw.githubusercontent.com/xfb1997/wloc-spoofer-en/refs/heads/main/modules/wloc.stoverride

**Shadowrocket:**
https://raw.githubusercontent.com/xfb1997/wloc-spoofer-en/refs/heads/main/modules/wloc.module

> Egern can use the Surge module directly
> For Stash, subscribe to the `.stoverride` above directly — no need to convert it with Script Hub

---

## Shortcuts (recommended, most convenient)

Switch / clear the location straight from the Shortcuts app, without opening the picker page:

- **wloc Set Location**: https://www.icloud.com/shortcuts/182f3a014597468eb1b15b99261cdf22
- **wloc Clear & Restore Location**: https://www.icloud.com/shortcuts/0352d53ed79849d382f50e9adf050662

**Usage**

- **Set location:** pick a spot in a Maps app (long-press the map to drop a pin) → Share → choose "wloc Set Location" to switch.
  - Apple Maps: pick a spot → Share → "wloc Set Location"
  - Amap: pick a spot → Share → **More** → "wloc Set Location"
- **Clear location:** tap "wloc Clear & Restore Location" to restore your real location.

Supports Apple Maps and Amap (including short links, with automatic redirect following + GCJ-02→WGS84 coordinate conversion).

> Prerequisites: proxy on + module enabled + `gs-loc.apple.com` trusted. The picker page (Worker / Pages) approach is still available; see below.

---

### About map link parsing (worker)

To make Apple Maps and Amap go through the same flow, links are sent to `wloc.wloclocation.cc.cd/api/parse` for parsing:

- **Amap**: shares produce a short link, and the real coordinates are hidden only in the `Location` header of the 302 redirect — and they are GCJ-02 offset coordinates. A Shortcut can neither read the redirect header nor easily do the coordinate conversion, so the worker follows the redirect → extracts the coordinates → converts GCJ-02→WGS84 → returns latitude/longitude.
- **Apple Maps**: the link carries `coordinate=lat,lon` directly, but **in mainland China these are also GCJ-02 offset coordinates**, so like Amap the worker performs the GCJ-02→WGS84 conversion before returning them; coordinates outside China skip the conversion automatically (`out_of_china` check) and are returned as-is. Beyond unifying the coordinate system, using the same endpoint also makes it easier to handle short links, links embedded in text, name decoding, and so on uniformly.

**Privacy:** `/api/parse` is a pure forward-and-parse endpoint — it receives a link → follows redirects → parses the coordinates → returns JSON, without writing any storage, logging, or caching anything; everything is discarded once done.

**Deploy your own if you're concerned:** the worker source is fully open source and you can deploy your own copy to replace the address above:

- Parsing logic: [`worker/src/parse.js`](worker/src/parse.js), routing: [`worker/src/index.js`](worker/src/index.js)
- After deploying, replace `wloc.wloclocation.cc.cd` in the Shortcut with your own worker domain.

---

<details>
<summary><b>How to use</b></summary>

1. Subscribe to the module and enable MITM
2. Open the online picker page (public Worker; adding it to the Home Screen is recommended)
3. Pick a location on the map / search a place name / paste a map link (the page opens centered on your current location, nothing is preset)
4. Tap "Save to Device"
5. It takes effect automatically the next time Apple location is triggered

Supports parsing Apple Maps / Google Maps / Amap / Baidu / coordinate text links.

> **Note for iOS 26/27 and later:** starting with iOS 26, Apple significantly strengthened `locationd`'s location cache. The system keeps previously obtained real location results in memory and reuses them for a long time. This means that after installing the module or switching the target coordinates, even if the script has successfully modified the WLOC response (the log shows "patched"), the system may keep using the old cached coordinates, so the location appears not to change.
>
> **Fix: restart the device.** A restart clears `locationd`'s in-memory cache, and the system will get the modified coordinates when it makes a new WLOC request. Toggling Airplane Mode, turning off Location Services, and similar tricks **cannot** clear this cache on iOS 26+; a restart is required. iOS 15–18 usually take effect without a restart.

**Recommended procedure for newer systems (highest success rate):**

Method 1:
1. First pick the location you want on the picker page and save it to the device
2. Turn on Airplane Mode → turn off Location Services → restart the device
3. Turn off Airplane Mode (turn off WiFi too) → connect the proxy tool (confirm the VPN icon appears) → turn on Location Services
4. Open Maps to verify

Method 2:
1. Turn off Location Services
2. Pick a location on the picker page and save it to the device
3. Turn on Location Services → when "Allow Once / Ask Next Time" appears, choose **"Ask Next Time Or When I Share"**
4. Open Maps to verify

</details>

<details>
<summary><b>How it works</b></summary>

```
picker page → fetch gs-loc.apple.com/wloc-settings/save?lon=x&lat=y
            → proxy module intercepts → wloc-settings.js writes to $persistentStore
            → next WLOC trigger → wloc.js reads coordinates → patches the protobuf response
```

The module contains two rules:
- `wloc.js` — intercepts the `/clls/wloc` response, parses the protobuf and replaces the coordinates
- `wloc-settings.js` — intercepts the `/wloc-settings/save` request and writes to persistent storage

</details>

<details>
<summary><b>Parameters</b></summary>

| Parameter | Description | Default |
|------|------|--------|
| longitude | Target longitude (online picker takes priority) | empty, i.e. passthrough the real location |
| latitude | Target latitude (online picker takes priority) | empty, i.e. passthrough the real location |
| accuracy | Accuracy (meters) | 25 |
| logLevel | Log level | info |

Priority: online picker save > module parameters > default value

The modules ship no preset city: while longitude/latitude stay empty the script passes the response through and the device keeps its own real network location. The picker page tries to move the map view onto your current position when it opens (view only, it never picks for you); rewriting starts once you tap "Save to Device".

</details>

<details>
<summary><b>Disable spoofing / restore real location</b></summary>

**Method 1: turn off or delete the module** (recommended)

Once the module is off, the script no longer intercepts WLOC requests and the system restores the real location automatically. iOS 26+ requires a device restart to clear the location cache.

**Method 2: clear the persisted data (passthrough mode)**

After clearing the saved coordinates, the script enters **passthrough mode** — it does not modify the WLOC response and lets the original data through, so the system restores the real GPS location automatically.

**Passthrough mode trigger condition:** when no longitude/latitude is set (the module arguments are empty and the persisted data is empty), the script decides that you have not chosen custom coordinates and skips the modification, so the device keeps using its real network location. The module arguments ship empty, so clearing the persisted data alone is enough to enter passthrough mode.

Delete the persisted data in your proxy tool; the field name is `wloc_settings`:

- **Surge** — run in the script editor: `$persistentStore.write(null, "wloc_settings")`
- **Quantumult X** — run: `$prefs.removeValueForKey("wloc_settings")`
- **Loon** — run: `$persistentStore.write(null, "wloc_settings")`

After clearing, restart the device to restore the real location. There is no need to turn off the module; the script automatically detects that there are no custom coordinates and skips modification.

> **Note:** if you type longitude/latitude into the module parameters, the script keeps using those coordinates even after clearing the persisted data. To go back to the real location, empty the coordinate parameters first, then clear the data. Nothing is hardcoded and no fixed city acts as a sentinel value, so any coordinate you enter always takes effect.

</details>

<details>
<summary><b>Favorites feature</b></summary>

The online picker page supports saving multiple locations as favorites, making it easy to switch back and forth:

- **Add a favorite**: after picking a location, tap "Add Favorite" → enter a label (Chinese/English/numbers supported, up to 30 characters) → save
- **Quick switch**: tap a location in the favorites list → the map jumps to it → tap "Save to Device" to switch
- **Active marker**: a favorite that matches the coordinates saved on the device shows "✓ Active now"
- **Manage/delete**: delete individually (× button) or clear all
- **Active coordinates**: the page shows the device-side persisted data (wloc_settings), with refresh-query and clear support

**Data storage notes:**
- **Favorites list** → stored in the browser's `localStorage` (used only for the picker page's UI convenience)
- **Active coordinates** → stored in the proxy tool's persistent storage `$persistentStore` (the data the script actually reads at runtime)

The two are stored independently. The favorites list is browser-side helper data; clearing the browser cache or switching browsers means you'll need to re-add favorites, but it does not affect the active coordinates already saved to the device.

</details>

<details>
<summary><b>Troubleshooting "Module not active"</b></summary>

The picker page and the module are separated by one hop through `gs-loc.apple.com`, so the same red banner can mean four unrelated things. Tap **Diagnose** in the "Active coordinates" card (a failed save fills it in automatically) and the page names the exact case:

| Diagnosis | What it really means | What to check |
|---|---|---|
| Request never completed (`TypeError: Failed to fetch`) | The browser could not reach `gs-loc.apple.com` at all | This traffic is not going through the proxy (proxy tool off, or the page opened in a desktop browser without the module); the MITM certificate is not fully trusted; the engine reply is missing CORS headers |
| Request reached Apple (`HTTP 404`) | MITM never intercepted this hostname | The module script failed to download (`raw.githubusercontent.com` is unreachable — by far the most common cause); the hostname is not in the MITM list; the module is off |
| Module is active, nothing saved yet | The script answered normally, you simply never saved | Everything is fine, tap "Save to Device" |
| Module is active, but this write failed | The script intercepted the request but could not persist it | Read the engine script log; writing `wloc_settings` is being blocked |

**Fastest self-check**: copy the check link from the diagnosis bar into the address bar (same-origin access is not subject to CORS).

```
https://gs-loc.apple.com/wloc-settings/save?action=query
```

- JSON comes back (`{"success":...}`) → the module path works; the page error can only be CORS headers or certificate trust
- `Not Found` comes back → the request hit the real Apple server, MITM is not in play. Check whether the module script actually downloaded (re-import the module, or point `script-path` at `dist/wloc-settings.js` yourself)
- The page will not open / certificate warning → this traffic bypasses the proxy, or the MITM certificate is not trusted

> If the module is on your iPhone, open the picker page in that phone's browser. Loading the same URL on a Mac or Windows browser will always fail this hop.

</details>

<details>
<summary><b>Rebuilding dist (for developers)</b></summary>

The `dist/wloc.js` and `dist/wloc-settings.js` files that the modules load are build artifacts; the source lives in `src/`:

```bash
npm install
npm run check   # build + behavior verification
```

- `src/wloc.js` / `src/wloc-settings.js`: the engine script sources
- `src/*.mjs`: the bundled runtime (logging, persistent storage, module argument parsing, result wrapping) that replaces the upstream `@nsnanocat/util`, keeping only what this project actually uses
- `scripts/build.mjs`: esbuild bundling, forced to pure ASCII output to dodge encoding issues in the different proxy tools
  - The build stamp in the artifact header is a content hash of `src/`, so rebuilding unchanged sources is byte-for-byte identical and never creates a phantom `dist/` diff
- `scripts/verify-dist.mjs`: runs the new artifacts and the committed ones side by side over the same synthetic payloads, and checks that empty arguments mean the real location

After editing `src/`, rebuild and commit `dist/` together: the module `script-path` entries point at `dist/`.

</details>

<details>
<summary><b>Self-hosting the Worker (recommended)</b></summary>

The public picker page has a request limit, so deploying your own instance is recommended:

- **Workers**: `https://wloc.wloclocation.cc.cd/`
- **Pages**: `https://<your-project-name>.pages.dev/`

**One-click deploy (Workers):**

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xfb1997/wloc-spoofer-en/tree/main/worker)

> One-click deploy only supports Workers mode; click the button and follow the prompts to authorize and finish the deployment.

**Manual deploy (Workers):**

```bash
# 1. Clone the repo
git clone https://github.com/xfb1997/wloc-spoofer-en.git
cd wloc-spoofer-en/worker

# 2. Install dependencies
npm install

# 3. Log in to Cloudflare (first time only)
npx wrangler login

# 4. Deploy
npm run deploy
```

Once deployed you'll get your own Worker address (e.g. `https://wloc-spoofer.<your-subdomain>.workers.dev`); use that address to pick locations.

> Free accounts get 100,000 requests per day, which is more than enough for personal use.

<details>
<summary>Advanced: Pages deployment</summary>

Pages deployment does not support the one-click button and must be done manually:

```bash
git clone https://github.com/xfb1997/wloc-spoofer-en.git
cd wloc-spoofer-en/worker
npm install
npx wrangler pages deploy dist --project-name <your-project-name>
```

During deployment you'll be prompted to set the production branch; enter `main`. Once deployed you'll get a `https://<project-name>.pages.dev` address.

Pages and Workers are functionally identical; choose whichever you prefer.

</details>

</details>

<details>
<summary><b>Notes</b></summary>

- Requires the MITM certificate to trust `gs-loc.apple.com` and `gs-loc-cn.apple.com`
- Only modifies network location (WiFi/cell); does not affect GPS hardware location
- iOS may ignore network location results when the GPS signal is strong
- Works best in indoor scenarios where WiFi-based location dominates
- The picker page must be used in proxy mode (Safari must go through the proxy to intercept the save request)

</details>

---

## Credits

- [Yu9191/wloc](https://github.com/Yu9191/wloc) - this project is forked from the original upstream implementation
- [proxypin-wloc-spoofer](https://github.com/FFF686868/proxypin-wloc-spoofer) - the original WLOC location modification idea by FFF686868
- [NSNanoCat/Util](https://github.com/NSNanoCat/util) - cross-platform scripting utility framework; the committed dist artifacts were originally built with it, now replaced by the minimal bundled runtime in this repo
