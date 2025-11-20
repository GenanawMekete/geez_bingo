const express = require("express");
const router = express.Router();
const db = require("./db");
const { broadcastGameUpdate } = require("./server");
const { initAutoDraw } = require("./timer");

// -------------------------
// Create a game
// -------------------------
router.post("/game/create", (req, res) => {
    const { host } = req.body;

    db.run(`INSERT INTO games (host) VALUES (?)`, [host], function(err) {
        if (err) return res.status(500).json({ error: err });

        return res.json({ gameId: this.lastID });
    });
});

// -------------------------
// Join game
// -------------------------
router.post("/game/join", (req, res) => {
    const { userId, gameId, card } = req.body;

    db.run(
        `INSERT INTO players (user_id, game_id, card) VALUES (?, ?, ?)`,
        [userId, gameId, JSON.stringify(card)],
        function(err) {
            if (err) return res.status(500).json({ error: err });

            // Notify all players in room
            broadcastGameUpdate(gameId, { newPlayer: userId });

            return res.json({ playerId: this.lastID });
        }
    );
});

// -------------------------
// Start game
// -------------------------
router.post("/game/start", (req, res) => {
    const { gameId } = req.body;

    db.run(`UPDATE games SET status = 'running' WHERE id = ?`, [gameId]);

    // Notify players
    broadcastGameUpdate(gameId, { status: "running" });

    // Start number drawing
    initAutoDraw(gameId);

    res.json({ status: "started" });
});

// -------------------------
// Get game data
// -------------------------
router.get("/game/:id", (req, res) => {
    const gameId = req.params.id;

    db.all(`SELECT number FROM draws WHERE game_id = ?`, [gameId], (err, rows) => {
        if (err) return res.status(500).json({ error: err });

        res.json({ draws: rows.map(r => r.number) });
    });
});

module.exports = router;