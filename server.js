// StudioLite Publish Proxy Server
// Deploy to Railway / Render / Glitch — any free Node.js host
//
// ENV VARS (set in your host's dashboard, never hardcode):
//   PROXY_SECRET   – a random string you invent; also set it in the Lua script
//   PORT           – set automatically by most hosts; defaults to 3000
//
// Endpoints:
//   POST /fetch-user-places  → lists ALL places across all of a user's games
//   POST /fetch-places        → lists places for ONE specific universe (legacy)
//   POST /publish             → publishes .rbxlx to a place version

const express = require("express");
const fetch   = require("node-fetch");   // npm install node-fetch@2
const app     = express();

app.use(express.json({ limit: "40mb" }));

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
// Body: { userId, proxySecret }   ← NO apiKey needed for listing
//
// Uses the public games.roblox.com API which already returns rootPlaceId for
// every game — no Open Cloud key required.  Returns a flat array of
// { name, placeId, universeId }.
app.post("/fetch-user-places", async (req, res) => {
    if (!checkSecret(req, res)) return;

    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: "userId is required" });

    try {
        // Public API — no key needed
        const gamesUrl =
            `https://games.roblox.com/v2/users/${userId}/games` +
            `?limit=50&sortOrder=Asc&accessFilter=All`;

        const gamesResp = await fetch(gamesUrl, {
            method:  "GET",
            headers: { "Accept": "application/json" },
        });

        if (!gamesResp.ok) {
            const txt = await gamesResp.text();
            console.error(`[fetch-user-places] games API ${gamesResp.status}: ${txt}`);
            return res.status(gamesResp.status).json({
                error: `Could not fetch games list (HTTP ${gamesResp.status}).`,
            });
        }

        const gamesData = await gamesResp.json();
        const games     = gamesData.data || [];

        if (games.length === 0) {
            return res.json([]);
        }

        // Each game already has rootPlaceId — use it directly, no extra API call
        const results = games
            .filter(g => g.rootPlaceId)
            .map(g => ({
                name:       g.name || `Universe ${g.id}`,
                placeId:    String(g.rootPlaceId),
                universeId: String(g.id),
            }));

        results.sort((a, b) => a.name.localeCompare(b.name));

        console.log(`[fetch-user-places] returning ${results.length} place(s) for user ${userId}`);
        return res.json(results);

    } catch (err) {
        console.error("[fetch-user-places] fatal:", err);
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
        const r = await fetch(url, {
            method:  "POST",
            headers: {
                "x-api-key":    apiKey,
                "Content-Type": "application/xml",
            },
            body: rbxlx,
        });
        const text = await r.text();
        res.status(r.status).set("Content-Type", "application/json").send(text);
    } catch (e) {
        res.status(500).json({ error: "Proxy publish error: " + e.message });
    }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("StudioLite Proxy OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`StudioLite proxy listening on :${PORT}`));
