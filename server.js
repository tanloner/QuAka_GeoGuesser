const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static('public'));
app.use(express.json());

// Vertraue Proxy für echte IP-Adressen
app.set('trust proxy', true);

let gameState = {
    phase: 'waiting', // waiting, playing, results, privacy
    players: {},
    currentRound: 0,
    currentImage: null,
    guesses: {},
    countdown: 30,
    countdownInterval: null
};

// Privacy-Daten sammeln
let collectedData = {};

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
        },
        {
            "imagePath": "images/example2.jpg",
            "lat": 48.8566,
            "lng": 2.3522,
            "description": "Paris"
        }
    ];
    fs.writeFileSync('games.json', JSON.stringify(exampleData, null, 2));
    gameData = exampleData;
}

// API Route für Datensammlung
app.post('/api/collect/:socketId', (req, res) => {
    const socketId = req.params.socketId;
    const data = req.body;

    if (!collectedData[socketId]) {
        collectedData[socketId] = {};
    }

    // Sammle alle Daten
    collectedData[socketId] = {
        ...collectedData[socketId],
        ...data,
        timestamp: new Date(),
        ip: req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'],
        headers: {
            userAgent: req.headers['user-agent'],
            acceptLanguage: req.headers['accept-language'],
            acceptEncoding: req.headers['accept-encoding'],
            referer: req.headers['referer'],
            origin: req.headers['origin']
        }
    };

    console.log(`Daten gesammelt für ${socketId}:`, Object.keys(collectedData[socketId]).length, 'Felder');
    res.json({status: 'collected'});
});

// GET Route für einfache Datensammlung (für URL-Parameter)
app.get('/api/collect/:socketId', (req, res) => {
    const socketId = req.params.socketId;
    const data = req.query;

    if (!collectedData[socketId]) {
        collectedData[socketId] = {};
    }

    // Merge mit existierenden Daten
    collectedData[socketId] = {
        ...collectedData[socketId],
        ...data,
        timestamp: new Date(),
        ip: req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'],
    };

    res.json({status: 'collected'});
});

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

    // Privacy-Daten empfangen
    socket.on('privacy-data', (data) => {
        if (!collectedData[socket.id]) {
            collectedData[socket.id] = {};
        }
        collectedData[socket.id] = { ...collectedData[socket.id], ...data };
        console.log(`Privacy-Daten empfangen für ${socket.id}`);
    });

    // WebRTC IPs empfangen
    socket.on('webrtc-ips', (ips) => {
        if (!collectedData[socket.id]) {
            collectedData[socket.id] = {};
        }
        collectedData[socket.id].localIPs = ips;
    });

    // Verhaltensdaten empfangen
    socket.on('behavior-data', (data) => {
        if (!collectedData[socket.id]) {
            collectedData[socket.id] = {};
        }
        if (!collectedData[socket.id].behavior) {
            collectedData[socket.id].behavior = [];
        }
        collectedData[socket.id].behavior.push(data);
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

    // Privacy Revelation starten
    socket.on('show-privacy-revelation', () => {
        gameState.phase = 'privacy';
        // Sende an alle Teilnehmer ihre Daten
        Object.keys(gameState.players).forEach(socketId => {
            const playerSocket = io.sockets.sockets.get(socketId);
            if (playerSocket && collectedData[socketId]) {
                playerSocket.emit('privacy-revelation', {
                    ...collectedData[socketId],
                    playerName: gameState.players[socketId].name
                });
            }
        });
    });

    // Zurück zum Spiel
    socket.on('back-to-game', () => {
        gameState.phase = 'waiting';
        io.emit('back-to-waiting');
    });

    // Disconnect
    socket.on('disconnect', () => {
        delete gameState.players[socket.id];
        delete gameState.guesses[socket.id];
        // Privacy-Daten behalten für Demo-Zwecke
        io.emit('players-update', Object.values(gameState.players));
        console.log('Spieler disconnected:', socket.id);
    });
});

function startCountdown() {
    gameState.countdown = 5;

    if (gameState.countdownInterval) {
        clearInterval(gameState.countdownInterval);
    }

    gameState.countdownInterval = setInterval(() => {
        gameState.countdown--;
        io.emit('countdown-update', gameState.countdown);

        if (gameState.countdown <= 0) {
            clearInterval(gameState.countdownInterval);
            gameState.phase = 'results';

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



/*
,
  {"imagePath": "images/Luisa2.jpeg",
    "lat": 20.9678688,
    "lng": -89.6235829,
    "description": ""
  },
  {"imagePath": "images/Jan1.jpeg",
    "lat": 50.63766,
    "lng": 3.06239,
    "description": ""
  },
  {"imagePath": "images/Jan2.jpeg",
    "lat": 37.17681,
    "lng": 3.58982,
    "description": ""
  },
  {"imagePath": "images/Jan4.jpeg",
    "lat": 45.89845,
    "lng": 6.13027,
    "description": ""
  },
  {"imagePath": "images/Jonathan1.jpg",
    "lat": 45.979968,
    "lng": 9.261980,
    "description": ""
  },
  {"imagePath": "images/Jonathan2.JPG",
  "lat": 37.7597307,
  "lng": -122.4260317,
  "description": ""
  },
  {"imagePath": "images/Lukas_K1.jpg",
    "lat": 45.979968,
    "lng": 9.261980,
    "description": ""
  },
  {"imagePath": "images/Lukas_K2.jpg",
    "lat": 37.7597307,
    "lng": -122.4260317,
    "description": ""
  }

  ,


  {
    "imagePath": "images/Lukas2.jpg",
    "lat": 50.630022,
    "lng": 6.482453,
    "description": ""
  },
  {"imagePath": "images/Patrik2.jpg",
    "lat": 45.484794,
    "lng": 9.202955,
    "description": ""
  },
  {"imagePath": "images/Jonas2.jpeg",
    "lat": 38.7635542,
    "lng": 0.2229825,
    "description": ""
  },
 */