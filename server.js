// StudioLite Publish Proxy Server
// Deploy to Railway / Render / Glitch — any free Node.js host
//
// ENV VARS (set in your host's dashboard, never hardcode):
//   PROXY_SECRET   – a random string you invent; also set it in the Lua script
//   PORT           – set automatically by most hosts; defaults to 3000
//
// Endpoints:
//   POST /fetch-user-places     → lists public games for a user
//   POST /fetch-universe-places → lists places for a specific universe via Open Cloud
//   POST /fetch-places          → lists places for ONE specific universe (legacy)
//   POST /publish               → publishes .rbxlx to a place version

const express = require("express");
const fetch   = require("node-fetch");   // npm install node-fetch@2  (used for non-Roblox calls only)
const https   = require("https");        // built-in — used for ALL Roblox Open Cloud calls
const app     = express();

// ── Body parser ───────────────────────────────────────────────────────────────
// Raise the JSON limit well above the largest expected rbxlx payload.
// The Lua script caps outbound size at ~4 MB; 24 MB here gives headroom
// without risking OOM on the host.
app.use(express.json({ limit: "24mb" }));

// ── Simple shared-secret guard ────────────────────────────────────────────────
const PROXY_SECRET = process.env.PROXY_SECRET || "change_me_to_something_random";

function checkSecret(req, res) {
    const s = req.headers["x-proxy-secret"] || req.body?.proxySecret;
    if (s !== PROXY_SECRET) {
        res.status(403).json({ error: "Forbidden — wrong proxy secret" });
        return false;
    }
    return true;
}

// ── httpsPostXml ──────────────────────────────────────────────────────────────
// Sends a raw XML buffer to a Roblox Open Cloud endpoint using Node's built-in
// https module.  This is the ONLY correct way to guarantee:
//   1. A single, accurate Content-Length header (derived from Buffer.byteLength)
//   2. No Transfer-Encoding: chunked (which the Roblox gateway rejects with 400
//      "Invalid Content stream")
//   3. No node-fetch v2 quirks around duplicate headers when Content-Type is
//      supplied alongside a Buffer body
//
// Returns { status: Number, body: String }
function httpsPostXml(urlStr, apiKey, bodyBuffer) {
    return new Promise((resolve, reject) => {
        let u;
        try { u = new URL(urlStr); }
        catch (e) { return reject(new Error("Bad URL: " + urlStr)); }

        const options = {
            hostname: u.hostname,
            port:     443,
            path:     u.pathname + u.search,
            method:   "POST",
            headers:  {
                "x-api-key":      apiKey,
                "Content-Type":   "application/xml",
                // Explicit, exact byte length — NOT "chunked", NOT omitted.
                // Roblox Open Cloud validates this header server-side and returns
                // 400 "Invalid Content stream" if it is absent or mismatched.
                "Content-Length": String(bodyBuffer.length),
            },
        };

        const req = https.request(options, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end",  ()  => resolve({
                status: res.statusCode,
                body:   Buffer.concat(chunks).toString("utf8"),
            }));
        });

        req.on("error", reject);

        // Write the full buffer in one call then close — no streaming, no chunking.
        req.write(bodyBuffer);
        req.end();
    });
}

// ── POST /fetch-user-places ───────────────────────────────────────────────────
// Body: { userId, proxySecret, apiKey? }
// Returns { results: [{ name, placeId, universeId }], hint? }
app.post("/fetch-user-places", async (req, res) => {
    if (!checkSecret(req, res)) return;

    const { userId, apiKey } = req.body;
    if (!userId) return res.status(400).json({ error: "userId is required" });

    const commonHeaders = {
        "Accept":          "application/json",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent":      "Mozilla/5.0 (compatible; StudioLiteProxy/2026)",
    };

    let games = [];

    try {
        // Strategy 1: v1 endpoint with accessFilter (most reliable for public games 2026)
        try {
            const url1 = `https://games.roblox.com/v1/users/${userId}/games` +
                         `?accessFilter=Public&limit=50&sortOrder=Asc`;
            const r1 = await fetch(url1, { method: "GET", headers: commonHeaders });
            if (r1.ok) {
                const d = await r1.json();
                const list = d.data || [];
                const seen = new Set(games.map(g => String(g.id)));
                for (const g of list) {
                    if (g.rootPlaceId && !seen.has(String(g.id))) {
                        games.push(g);
                        seen.add(String(g.id));
                    }
                }
            }
        } catch (_) { /* best-effort */ }

        // Strategy 2: v2 endpoint (legacy fallback)
        try {
            const url2 = `https://games.roblox.com/v2/users/${userId}/games` +
                         `?limit=50&sortOrder=Asc`;
            const r2 = await fetch(url2, { method: "GET", headers: commonHeaders });
            if (r2.ok) {
                const d = await r2.json();
                const list = d.data || [];
                const seen = new Set(games.map(g => String(g.id)));
                for (const g of list) {
                    if (g.rootPlaceId && !seen.has(String(g.id))) {
                        games.push(g);
                        seen.add(String(g.id));
                    }
                }
            }
        } catch (_) { /* best-effort */ }

        if (games.length === 0) {
            const hint = apiKey
                ? "Your game may be private or unlisted. Enter your Universe ID below to continue."
                : "No public games found. Enter your Universe ID and API key to publish.";
            console.log(`[fetch-user-places] 0 games for user ${userId} — returning hint`);
            return res.json({ results: [], hint });
        }

        const results = games
            .filter(g => g.rootPlaceId)
            .map(g => ({
                name:       g.name || `Universe ${g.id}`,
                placeId:    String(g.rootPlaceId),
                universeId: String(g.id),
            }));

        results.sort((a, b) => a.name.localeCompare(b.name));
        console.log(`[fetch-user-places] ${results.length} place(s) for user ${userId}`);
        return res.json({ results });

    } catch (err) {
        console.error("[fetch-user-places] fatal:", err);
        return res.status(500).json({ error: "Proxy error: " + err.message });
    }
});

// ── POST /fetch-universe-places ───────────────────────────────────────────────
// For private/unlisted games — user provides Universe ID + API key.
// Body: { apiKey, universeId, proxySecret }
// Returns { results: [{ name, placeId, universeId }], universeName }
app.post("/fetch-universe-places", async (req, res) => {
    if (!checkSecret(req, res)) return;

    const { apiKey, universeId } = req.body;
    if (!apiKey || !universeId)
        return res.status(400).json({ error: "apiKey and universeId are required" });

    try {
        let universeName = `Universe ${universeId}`;
        try {
            const infoUrl  = `https://apis.roblox.com/cloud/v2/universes/${universeId}`;
            const infoResp = await fetch(infoUrl, {
                method: "GET",
                headers: { "x-api-key": apiKey, "Accept": "application/json" },
            });
            if (infoResp.ok) {
                const info = await infoResp.json();
                universeName = info.displayName || info.name || universeName;
            }
        } catch (_) { /* non-fatal */ }

        const placesUrl  = `https://apis.roblox.com/cloud/v2/universes/${universeId}/places?maxPageSize=50`;
        const placesResp = await fetch(placesUrl, {
            method:  "GET",
            headers: { "x-api-key": apiKey, "Accept": "application/json" },
        });

        if (!placesResp.ok) {
            return res.status(placesResp.status).json({
                error: `Places lookup failed (${placesResp.status}). Check your API key has universe.place:read scope.`
            });
        }

        const placesData = await placesResp.json();
        const raw = placesData.places || placesData.resources || [];
        const results = raw.map(pl => {
            let pid = pl.placeId || pl.id;
            if (!pid && typeof pl.path === "string")
                pid = pl.path.match(/\/places\/(\d+)$/)?.[1];
            return pid ? {
                name:       pl.displayName || pl.name || `Place ${pid}`,
                placeId:    String(pid),
                universeId: String(universeId),
            } : null;
        }).filter(Boolean);

        console.log(`[fetch-universe-places] ${results.length} place(s) for universe ${universeId}`);
        return res.json({ results, universeName });

    } catch (err) {
        console.error("[fetch-universe-places] fatal:", err);
        return res.status(500).json({ error: "Proxy error: " + err.message });
    }
});

// ── POST /fetch-places ────────────────────────────────────────────────────────
// Legacy endpoint. Body: { apiKey, universeId, proxySecret }
app.post("/fetch-places", async (req, res) => {
    if (!checkSecret(req, res)) return;

    const { apiKey, universeId } = req.body;
    if (!apiKey || !universeId)
        return res.status(400).json({ error: "apiKey and universeId are required" });

    const url = `https://apis.roblox.com/cloud/v2/universes/${universeId}/places?maxPageSize=50`;
    try {
        const r = await fetch(url, {
            method:  "GET",
            headers: { "x-api-key": apiKey, "Accept": "application/json" },
        });
        const text = await r.text();
        res.status(r.status).set("Content-Type", "application/json").send(text);
    } catch (e) {
        res.status(500).json({ error: "Proxy fetch error: " + e.message });
    }
});

// ── POST /debug ───────────────────────────────────────────────────────────────
// Returns the received rbxlx XML as plain text WITHOUT sending it to Roblox.
// Use this to verify the exact XML content being generated by the Lua script:
//   curl -X POST https://<your-proxy>/debug \
//     -H "Content-Type: application/json" \
//     -H "x-proxy-secret: <secret>" \
//     -d '{"proxySecret":"<secret>","rbxlx":"<xml>","apiKey":"","universeId":"","placeId":""}'
app.post("/debug", (req, res) => {
    if (!checkSecret(req, res)) return;
    const { rbxlx } = req.body;
    if (!rbxlx) return res.status(400).send("No rbxlx field in body");
    const buf = Buffer.from(rbxlx, "utf8");
    console.log(`[debug] rbxlx length=${rbxlx.length} chars / ${buf.length} bytes`);
    console.log(`[debug] first 600 chars:\n${rbxlx.slice(0, 600)}`);
    res.set("Content-Type", "application/xml").send(rbxlx);
});

// ── POST /publish ─────────────────────────────────────────────────────────────
// Body: { apiKey, universeId, placeId, rbxlx (string), proxySecret }
app.post("/publish", async (req, res) => {
    if (!checkSecret(req, res)) return;

    const { apiKey, universeId, placeId, rbxlx } = req.body;
    if (!apiKey || !universeId || !placeId || !rbxlx)
        return res.status(400).json({ error: "apiKey, universeId, placeId, rbxlx are required" });

    // Sanity-check the payload looks like XML.
    if (!rbxlx.startsWith("<?xml") && !rbxlx.startsWith("<roblox")) {
        console.error("[publish] Payload is not XML — first 200 chars:", rbxlx.slice(0, 200));
        return res.status(400).json({
            error: "rbxlx field does not look like valid XML. Check Lua serializer output."
        });
    }

    const url = `https://apis.roblox.com/universes/v1/${universeId}/places/${placeId}/versions?versionType=Published`;

    try {
        // Build the exact byte buffer that will be written to the wire.
        // Buffer.from(string, "utf8") is authoritative — .length gives the byte
        // count (not the character count), which is what we put in Content-Length.
        const bodyBuffer = Buffer.from(rbxlx, "utf8");

        console.log(
            `[publish] universe=${universeId} place=${placeId}` +
            ` chars=${rbxlx.length} bytes=${bodyBuffer.length}`
        );

        // Use httpsPostXml (native https) so Content-Length is explicit and single.
        // node-fetch v2 cannot guarantee this when a custom Content-Type header is
        // also present — it may omit Content-Length or the Node http layer may add
        // Transfer-Encoding: chunked, both of which trigger Roblox's 400 rejection.
        const r = await httpsPostXml(url, apiKey, bodyBuffer);

        if (r.status !== 200) console.error(`[publish] Non-200: ${r.status}`, r.body);
        else                  console.log(`[publish] Success: ${r.status}`, r.body);

        res.status(r.status).set("Content-Type", "application/json").send(r.body);

    } catch (e) {
        console.error("[publish] fatal:", e);
        res.status(500).json({ error: "Proxy publish error: " + e.message });
    }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("StudioLite Proxy OK — 2026 build"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`StudioLite proxy listening on :${PORT}`));
