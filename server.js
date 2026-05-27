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

// ── POST /fetch-user-places ───────────────────────────────────────────────────
// Body: { apiKey, userId, proxySecret }
//
// Flow:
//   1. Call games.roblox.com to list the user's games (public API, no key needed).
//   2. For each game (up to MAX_GAMES), call Open Cloud to list its places.
//   3. Return a flat array of { name, placeId, universeId }.
//
// The "name" is formatted as  "<GameName> — <PlaceName>"  so the dropdown is
// readable when a game has several places.
app.post("/fetch-user-places", async (req, res) => {
    if (!checkSecret(req, res)) return;

    const { apiKey, userId } = req.body;
    if (!apiKey)  return res.status(400).json({ error: "apiKey is required" });
    if (!userId)  return res.status(400).json({ error: "userId is required" });

    const MAX_GAMES = 10;   // cap so we don't hammer the API

    try {
        // ── Step 1: fetch the user's games (public, no API key) ───────────────
        const gamesUrl =
            `https://games.roblox.com/v2/users/${userId}/games` +
            `?limit=50&sortOrder=Asc&accessFilter=2`;

        const gamesResp = await fetch(gamesUrl, {
            method:  "GET",
            headers: { "Accept": "application/json" },
        });

        if (!gamesResp.ok) {
            const txt = await gamesResp.text();
            console.error(`[fetch-user-places] games API ${gamesResp.status}: ${txt}`);
            return res.status(gamesResp.status).json({
                error: `Could not fetch games list (HTTP ${gamesResp.status}). Check your userId.`,
            });
        }

        const gamesData = await gamesResp.json();
        const games     = (gamesData.data || []).slice(0, MAX_GAMES);

        if (games.length === 0) {
            return res.json([]);   // no games → empty list
        }

        // ── Step 2: for each game, fetch its places via Open Cloud ────────────
        const results = [];

        await Promise.all(games.map(async (game) => {
            // games.roblox.com returns  { id: universeId, rootPlaceId, name, … }
            const universeId = String(game.id);
            const gameName   = game.name || `Universe ${universeId}`;

            try {
                const placesUrl =
                    `https://apis.roblox.com/cloud/v2/universes/${universeId}/places?maxPageSize=50`;

                const placesResp = await fetch(placesUrl, {
                    method:  "GET",
                    headers: {
                        "x-api-key": apiKey,
                        "Accept":    "application/json",
                    },
                });

                if (!placesResp.ok) {
                    // Silently skip games the API key can't access (e.g. wrong scope)
                    console.warn(
                        `[fetch-user-places] universe ${universeId} → HTTP ${placesResp.status}`
                    );
                    return;
                }

                const placesData = await placesResp.json();
                const raw        = placesData.places || placesData.resources || [];

                for (const pl of raw) {
                    // Cloud v2 path: "universes/NNN/places/MMM"
                    let placeId = pl.placeId || pl.id;
                    if (!placeId && typeof pl.path === "string") {
                        const m = pl.path.match(/\/places\/(\d+)$/);
                        if (m) placeId = m[1];
                    }
                    if (!placeId) continue;

                    const placeName = pl.displayName || pl.name || `Place ${placeId}`;

                    // If the game only has one place, just show the game name.
                    // If it has multiple, show "GameName — PlaceName".
                    const displayName =
                        raw.length === 1
                            ? gameName
                            : `${gameName} — ${placeName}`;

                    results.push({
                        name:       displayName,
                        placeId:    String(placeId),
                        universeId: universeId,
                    });
                }
            } catch (innerErr) {
                console.error(`[fetch-user-places] inner error for universe ${universeId}:`, innerErr);
            }
        }));

        // Sort alphabetically so the dropdown is easy to read
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
