const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static('public'));

let gameState = {
    phase: 'waiting', // waiting, playing, results
    players: {},
    currentRound: 0,
    currentImage: null,
    guesses: {},
    countdown: 30,
    countdownInterval: null
};

// Lade Spiel-Daten
let gameData = [];
try {
    gameData = JSON.parse(fs.readFileSync('games.json', 'utf8'));
} catch (error) {
    console.log('games.json nicht gefunden, erstelle Beispiel...');
    const exampleData = [
        {
            "imagePath": "images/example1.jpg",
            "lat": 52.5200,
            "lng": 13.4050,
            "description": "Berlin"
        }
    ];
    fs.writeFileSync('games.json', JSON.stringify(exampleData, null, 2));
    gameData = exampleData;
}

io.on('connection', (socket) => {
    console.log('Neue Verbindung:', socket.id);

    // Teilnehmer registrieren
    socket.on('register-player', (data) => {
        gameState.players[socket.id] = {
            name: data.name,
            device: data.device,
            socketId: socket.id
        };

        io.emit('players-update', Object.values(gameState.players));
        console.log(`Spieler registriert: ${data.name}`);
    });

    // Admin startet Spiel
    socket.on('start-game', () => {
        if (gameData.length === 0) {
            socket.emit('error', 'Keine Bilder in games.json gefunden!');
            return;
        }

        gameState.phase = 'playing';
        gameState.currentRound = 0;
        gameState.currentImage = gameData[gameState.currentRound];
        gameState.guesses = {};

        startCountdown();
        io.emit('game-started', {
            image: gameState.currentImage,
            countdown: gameState.countdown
        });
    });

    // Spieler-Guess empfangen
    socket.on('submit-guess', (data) => {
        if (gameState.phase !== 'playing') return;

        gameState.guesses[socket.id] = {
            playerName: gameState.players[socket.id]?.name || 'Unbekannt',
            lat: data.lat,
            lng: data.lng,
            timestamp: Date.now()
        };

        console.log(`Guess von ${gameState.players[socket.id]?.name}: ${data.lat}, ${data.lng}`);

        // Admin über neuen Guess informieren
        io.emit('new-guess', {
            playerName: gameState.players[socket.id]?.name,
            totalGuesses: Object.keys(gameState.guesses).length
        });
    });

    // Nächste Runde
    socket.on('next-round', () => {
        gameState.currentRound++;

        if (gameState.currentRound >= gameData.length) {
            // Spiel beendet
            gameState.phase = 'finished';
            io.emit('game-finished');
            return;
        }

        gameState.phase = 'playing';
        gameState.currentImage = gameData[gameState.currentRound];
        gameState.guesses = {};

        startCountdown();
        io.emit('next-round', {
            image: gameState.currentImage,
            countdown: gameState.countdown,
            round: gameState.currentRound + 1,
            totalRounds: gameData.length
        });
    });

    // Disconnect
    socket.on('disconnect', () => {
        delete gameState.players[socket.id];
        delete gameState.guesses[socket.id];
        io.emit('players-update', Object.values(gameState.players));
        console.log('Spieler disconnected:', socket.id);
    });
});

function startCountdown() {
    gameState.countdown = 30; // Änderbar

    if (gameState.countdownInterval) {
        clearInterval(gameState.countdownInterval);
    }

    gameState.countdownInterval = setInterval(() => {
        gameState.countdown--;
        io.emit('countdown-update', gameState.countdown);

        if (gameState.countdown <= 0) {
            clearInterval(gameState.countdownInterval);
            gameState.phase = 'results';

            // Ergebnisse senden
            io.emit('round-finished', {
                correctLocation: {
                    lat: gameState.currentImage.lat,
                    lng: gameState.currentImage.lng
                },
                guesses: gameState.guesses
            });
        }
    }, 1000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server läuft auf Port ${PORT}`);
    console.log(`Teilnehmer: http://localhost:${PORT}/client.html`);
    console.log(`Admin: http://localhost:${PORT}/admin.html`);
});
