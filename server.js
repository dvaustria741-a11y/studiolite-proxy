// StudioLite Publish Proxy Server
// Deploy to Railway / Render / Glitch — any free Node.js host
//
// ENV VARS (set in your host's dashboard, never hardcode):
//   PROXY_SECRET   – a random string you invent; also set it in the Lua script
//                    so random people can't use your proxy
//   PORT           – set automatically by most hosts; defaults to 3000
//
// Endpoints:
//   POST /fetch-places   → lists places for a universe
//   POST /publish        → publishes .rbxlx to a place version

const express = require("express");
const fetch   = require("node-fetch");   // npm install node-fetch@2
const app     = express();

app.use(express.json({ limit: "10mb" }));

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

// ── POST /fetch-places ────────────────────────────────────────────────────────
// Body: { apiKey, universeId, proxySecret }
// Returns the raw Roblox Cloud v2 JSON (places array)
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
// Returns the Roblox publish response JSON
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
