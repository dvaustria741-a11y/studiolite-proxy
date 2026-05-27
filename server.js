// StudioLite Publish Proxy Server
// Deploy to Railway / Render / Glitch — any free Node.js host
//
// ENV VARS (set in your host's dashboard, never hardcode):
//   PROXY_SECRET   – a random string you invent; also set it in the Lua script
//   PORT           – set automatically by most hosts; defaults to 3000
//
// Endpoints:
//   POST /fetch-user-places   → lists public games for a user (may return hint for private games)
//   POST /fetch-universe-places → lists places for a specific universe via Open Cloud (NEW 2026)
//   POST /fetch-places        → lists places for ONE specific universe (legacy)
//   POST /publish             → publishes .rbxlx to a place version

const express = require("express");
const fetch   = require("node-fetch");   // npm install node-fetch@2
const app     = express();

app.use(express.json({ limit: "36mb" }));

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

// ── POST /fetch-user-places ───────────────────────────────────────────────────
// Body: { userId, proxySecret, apiKey? }
//
// 2026: games.roblox.com now requires auth for private/unlisted games.
// This endpoint tries the public APIs first.
// If nothing is found and apiKey is present, returns a hint telling the
// client to call /fetch-universe-places with a manually-entered universe ID.
//
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
// NEW 2026: For private/unlisted games — user provides Universe ID + API key.
// Body: { apiKey, universeId, proxySecret }
// Returns { results: [{ name, placeId, universeId }], universeName }
app.post("/fetch-universe-places", async (req, res) => {
    if (!checkSecret(req, res)) return;

    const { apiKey, universeId } = req.body;
    if (!apiKey || !universeId)
        return res.status(400).json({ error: "apiKey and universeId are required" });

    try {
        // Get universe info (to show the universe name in the UI)
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

        // Get places in this universe
        const placesUrl  = `https://apis.roblox.com/cloud/v2/universes/${universeId}/places?maxPageSize=50`;
        const placesResp = await fetch(placesUrl, {
            method:  "GET",
            headers: { "x-api-key": apiKey, "Accept": "application/json" },
        });

        if (!placesResp.ok) {
            const txt = await placesResp.text();
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
// Legacy endpoint — still works if you know the universeId.
// Body: { apiKey, universeId, proxySecret }
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

// ── POST /publish ─────────────────────────────────────────────────────────────
// Body: { apiKey, universeId, placeId, rbxlx (string), proxySecret }
app.post("/publish", async (req, res) => {
    if (!checkSecret(req, res)) return;

    const { apiKey, universeId, placeId, rbxlx } = req.body;
    if (!apiKey || !universeId || !placeId || !rbxlx)
        return res.status(400).json({ error: "apiKey, universeId, placeId, rbxlx are required" });

    const url = `https://apis.roblox.com/universes/v1/${universeId}/places/${placeId}/versions?versionType=Published`;
    try {
        const bodyBuffer = Buffer.from(rbxlx, "utf8");
        const r = await fetch(url, {
            method:  "POST",
            headers: {
                "x-api-key": apiKey,
                // IMPORTANT: Must be application/xml for .rbxlx (XML text) files.
                // Using application/octet-stream here causes "Invalid Content stream" 400 errors.
                "Content-Type":   "application/xml",
                "Content-Length": String(bodyBuffer.length),
            },
            body: bodyBuffer,
        });
        const text = await r.text();
        res.status(r.status).set("Content-Type", "application/json").send(text);
    } catch (e) {
        res.status(500).json({ error: "Proxy publish error: " + e.message });
    }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("StudioLite Proxy OK — 2026 build"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`StudioLite proxy listening on :${PORT}`));
