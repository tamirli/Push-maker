const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors'); // Ideally require cors if used, but we are doing socket io cors

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Allow all origins for Itch.io
        methods: ["GET", "POST"]
    }
});

app.use(express.static('public'));

// --- משתני המשחק ---
let players = {}; // Key: SocketID
let gameStatus = 'LOBBY';
let currentRoundNumber = 0;
const ROOM_CODE = "ABCD";
const GAME_CONFIG = {
    WRITING_TIME_MS: 60000,
    VOTING_TIME_MS: 20000
};

let phaseTimeout = null;
let warningTimeout = null;

// מבנה הנתונים לסיבוב הנוכחי
let currentRoundData = {
    questions: [], // יכיל 3 שאלות
    submissions: [[], [], []], // מערך להגשות ל-3 שאלות
    votingStep: 0, // 0-2
    currentOptions: [], // האפשרויות המוצגות כרגע להצבעה
    votes: {}, // מי הצביע למה בסיבוב הנוכחי
    stepResultsShown: false
};

// מעקב אחרי שאלות שכבר היו (כדי שלא יחזרו)
let usedQuestionIndices = [];

// --- מאגר השאלות המלא (33 שאלות) ---
const fs = require('fs');
const path = require('path');

// --- טעינת שאלות מקובץ CSV ---
function loadQuestionsFromCSV() {
    try {
        const csvPath = path.join(__dirname, 'questions.csv');
        const fileContent = fs.readFileSync(csvPath, 'utf8');
        const lines = fileContent.trim().split(/\r?\n/);

        if (lines.length < 2) return []; // Header only or empty

        const headers = lines[0].split(','); // Assuming simple headers: prompt,missing,original
        const questions = [];

        for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            if (!line.trim()) continue;

            const row = [];
            let inQuote = false;
            let currentField = '';

            for (let j = 0; j < line.length; j++) {
                const char = line[j];
                const nextChar = line[j + 1];

                if (char === '"') {
                    if (inQuote && nextChar === '"') {
                        currentField += '"';
                        j++; // Skip escaped quote
                    } else {
                        inQuote = !inQuote;
                    }
                } else if (char === ',' && !inQuote) {
                    row.push(currentField);
                    currentField = '';
                } else {
                    currentField += char;
                }
            }
            row.push(currentField); // Last field

            // Map to object based on headers or known order
            // New CSV Order: Original(0), Prompt(1), Missing(2), Source(3)
            if (row.length >= 4) {
                questions.push({
                    prompt: row[1],
                    missing: row[2],
                    original: row[0],
                    source: row[3] || '',
                    difficulty: parseInt(row[4]) || 1, // Default to 1 if missing
                    audioFile: row[5] ? `headline_read/${row[5].trim()}.mp3` : null // Map to folder
                });
            }
        }
        console.log(`Loaded ${questions.length} questions from CSV.`);
        if (questions.length > 0) {
            console.log("Sample Question 0:", questions[0]);
        }
        return questions;
    } catch (err) {
        console.error("Error loading CSV:", err);
        return [];
    }
}

const questionsDatabase = loadQuestionsFromCSV();

const os = require('os'); // Added for IP detection

function getLocalIp() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            // Skip internal (non-127.0.0.1) and non-IPv4 addresses
            if ('IPv4' !== iface.family || iface.internal) {
                continue;
            }
            return iface.address;
        }
    }
    return 'localhost'; // Fallback
}

io.on('connection', (socket) => {
    console.log('מישהו התחבר:', socket.id);

    socket.on('host_connect', () => {
        console.log("Host connected -> Resetting Game State");

        // Kick all existing players
        io.emit('kick_player');

        // Reset Server State
        players = {};
        gameStatus = 'LOBBY';
        currentRoundNumber = 0;
        currentRoundData = {
            questions: [],
            submissions: [[], [], []],
            votingStep: 0,
            currentOptions: [],
            votes: {},
            stepResultsShown: false
        };
        usedQuestionIndices = [];

        socket.join('host_room');
        io.to('host_room').emit('update_player_list', []);

        // Send IP Info for QR Code
        const localIp = getLocalIp();
        socket.emit('server_info', { ip: localIp, port: 3000 });
    });

    socket.on('player_attempt_join', (code) => {
        if (!code) {
            socket.emit('join_error', 'קוד חסר');
            return;
        }

        const cleanCode = (typeof code === 'string' ? code : code.code).toUpperCase().trim();
        const playerUUID = (typeof code === 'object') ? code.uuid : null;

        if (cleanCode !== ROOM_CODE) {
            socket.emit('join_error', 'קוד שגוי');
            return;
        }

        // Check Reconnection
        if (playerUUID) {
            const existingPlayerId = Object.keys(players).find(pid => players[pid].uuid === playerUUID);
            if (existingPlayerId) {
                // Reconnect!
                const p = players[existingPlayerId];
                console.log(`Player ${p.nickname} reconnecting... ID: ${existingPlayerId} -> ${socket.id}`);

                // SWAP ID
                players[socket.id] = p;
                delete players[existingPlayerId];
                p.id = socket.id;
                p.connected = true;

                // Update References
                currentRoundData.submissions.forEach(subList => {
                    subList.forEach(sub => {
                        if (sub.playerId === existingPlayerId) sub.playerId = socket.id;
                    });
                });
                if (currentRoundData.votes[existingPlayerId] !== undefined) {
                    currentRoundData.votes[socket.id] = currentRoundData.votes[existingPlayerId];
                    delete currentRoundData.votes[existingPlayerId];
                }
                if (currentRoundData.currentOptions) {
                    currentRoundData.currentOptions.forEach(opt => {
                        if (opt.playerId === existingPlayerId) opt.playerId = socket.id;
                    });
                }

                socket.join('players_room');
                socket.emit('join_success'); // Client goes to Register? No, we skip.
                // Mobile client logic: join_success -> screen-register.
                // We want to skip register.
                // Let's send a special 'reconnect_success' or just manage 'join_success' and then 'move_to...'

                // Actually, client goes to 'screen-register'.
                // If we emit 'restore_game_state', handling it on client would be nice.
                // But let's just emit 'join_success' and then immediately 'move_to_writing' etc. 
                // The client will switch screen if it receives 'move_to...'.

                // Restore State
                if (gameStatus === 'WRITING') {
                    if (p.headlinesWritten < 3) {
                        const nextIdx = p.headlinesWritten;
                        socket.emit('move_to_writing', {
                            prompt: currentRoundData.questions[nextIdx].prompt,
                            source: currentRoundData.questions[nextIdx].source,
                            questionNum: nextIdx + 1,
                            duration: null
                        });
                    } else {
                        socket.emit('wait_for_others');
                    }
                } else if (gameStatus === 'VOTING') {
                    socket.emit('move_to_voting_screen', {
                        options: currentRoundData.currentOptions,
                        duration: null
                    });
                    if (currentRoundData.votes[socket.id] !== undefined) {
                        socket.emit('wait_for_others');
                    }
                } else {
                    socket.emit('wait_for_others');
                }

                io.to('host_room').emit('player_reconnected', { playerId: socket.id });
                io.to('host_room').emit('update_player_list', Object.values(players));
                return;
            }
        }

        if (Object.keys(players).length >= 6) {
            socket.emit('join_error', 'החדר מלא (מקסימום 6 שחקנים)');
            return;
        }

        socket.emit('join_success');
    });

    socket.on('player_register', (data) => {
        players[socket.id] = {
            id: socket.id,
            uuid: data.uuid,
            nickname: data.nickname,
            gender: data.gender,
            favThing: data.favThing,
            journalisticSpecialty: (data.gender === 'male' ? 'כתב לעינייני ' : (data.gender === 'female' ? 'כתבת לעינייני ' : 'כתב/ת לעינייני ')) + data.favThing,
            score: 0,
            roundScore: 0,
            headlinesWritten: 0,
            connected: true
        };
        socket.join('players_room');

        io.to('host_room').emit('player_joined', players[socket.id]);
        io.to('host_room').emit('update_player_list', Object.values(players));
    });

    socket.on('host_start_game', () => {
        // Reset Scores for ALL players
        for (let pid in players) {
            players[pid].score = 0;
            players[pid].roundScore = 0;
            players[pid].headlinesWritten = 0;
        }

        io.to('host_room').emit('update_player_list', Object.values(players));

        // Start Instructions Phase
        currentRoundNumber = 0;
        gameStatus = 'INSTRUCTIONS';
        io.to('host_room').emit('host_phase_instructions');
    });

    socket.on('host_restart_game', () => {
        console.log("Restarting Game...");
        currentRoundNumber = 0;
        gameStatus = 'INSTRUCTIONS';
        usedQuestionIndices = [];

        currentRoundData = {
            questions: [],
            submissions: [[], [], []],
            votingStep: 0,
            currentOptions: [],
            votes: {},
            stepResultsShown: false
        };

        for (let pid in players) {
            players[pid].score = 0;
            players[pid].roundScore = 0;
            players[pid].headlinesWritten = 0;
        }

        io.to('host_room').emit('update_player_list', Object.values(players));
        io.to('host_room').emit('host_phase_instructions');
    });

    socket.on('host_start_round', () => {
        startNewRound();
    });

    function startNewRound() {
        currentRoundNumber++;

        // Check for Game Over (After Round 4)
        if (currentRoundNumber > 4) {
            const sortedPlayers = Object.values(players).sort((a, b) => b.score - a.score);
            io.to('host_room').emit('game_winner_reveal', sortedPlayers);
            gameStatus = 'WINNER';
            return;
        }

        gameStatus = 'WRITING';
        currentRoundData.submissions = [[], [], []];
        currentRoundData.votingStep = 0;
        currentRoundData.votes = {};
        currentRoundData.stepResultsShown = false;

        for (let pid in players) {
            players[pid].headlinesWritten = 0;
            players[pid].roundScore = 0;
        }

        // --- Select 3 Questions based on Round Difficulty ---
        const qConfig = {
            1: { 1: 3, 2: 0, 3: 0 },
            2: { 1: 2, 2: 1, 3: 0 },
            3: { 1: 0, 2: 3, 3: 0 },
            4: { 1: 0, 2: 0, 3: 3 }
        };

        const config = qConfig[currentRoundNumber] || { 1: 3, 2: 0, 3: 0 };
        const selectedIndices = [];

        // Helper to get random unique indices
        const getQuestionsByDiff = (diff, count) => {
            const available = questionsDatabase
                .map((q, idx) => ({ ...q, originalIndex: idx }))
                .filter(q => q.difficulty === diff && !usedQuestionIndices.includes(q.originalIndex));

            for (let i = available.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [available[i], available[j]] = [available[j], available[i]];
            }

            return available.slice(0, count).map(q => q.originalIndex);
        };

        const diff1 = getQuestionsByDiff(1, config[1]);
        const diff2 = getQuestionsByDiff(2, config[2]);
        const diff3 = getQuestionsByDiff(3, config[3]);

        let picked = [...diff1, ...diff2, ...diff3];

        if (picked.length < 3) {
            console.warn("Not enough questions of required difficulty! Filling with randoms.");
            const remaining = 3 - picked.length;
            const extra = getQuestionsByDiff(1, 100).concat(getQuestionsByDiff(2, 100)).concat(getQuestionsByDiff(3, 100));
            const extraUnique = extra.filter(idx => !picked.includes(idx));
            picked = picked.concat(extraUnique.slice(0, remaining));
        }

        usedQuestionIndices.push(...picked);
        currentRoundData.questions = picked.map(idx => questionsDatabase[idx]);

        console.log(`Round ${currentRoundNumber} Questions:`, currentRoundData.questions.map(q => `${q.prompt} (D${q.difficulty})`));

        io.emit('move_to_writing', {
            prompt: currentRoundData.questions[0].prompt,
            source: currentRoundData.questions[0].source,
            questionNum: 1,
            duration: GAME_CONFIG.WRITING_TIME_MS
        });
        io.to('host_room').emit('host_phase_writing', {
            totalQuestions: 3,
            questions: currentRoundData.questions.map(q => ({
                prompt: q.prompt,
                audio: q.audioFile
            })),
            duration: GAME_CONFIG.WRITING_TIME_MS,
            roundNum: currentRoundNumber
        });

        // Set timer for writing phase
        if (phaseTimeout) clearTimeout(phaseTimeout);
        if (warningTimeout) clearTimeout(warningTimeout);

        if (GAME_CONFIG.WRITING_TIME_MS > 10000) {
            warningTimeout = setTimeout(() => {
                io.emit('hurry_up');
            }, GAME_CONFIG.WRITING_TIME_MS - 10000);
        }

        phaseTimeout = setTimeout(() => {
            console.log("Writing time over!");
            currentRoundData.votingStep = 0;
            startVotingPhase();
        }, GAME_CONFIG.WRITING_TIME_MS);
    }

    // --- בדיקת דמיון לתשובה האמיתית ---
    function normalizeString(str) {
        return str.replace(/[^\w\u0590-\u05FF]/g, '').toLowerCase();
    }

    function isTooSimilar(submission, truth) {
        const normSub = normalizeString(submission);
        const normTruth = normalizeString(truth);
        if (!normSub || !normTruth) return false;
        if (normSub === normTruth) return true;
        if (normTruth.length > 2) {
            if (normSub.includes(normTruth) || normTruth.includes(normSub)) return true;
        }
        return false;
    }

    socket.on('submit_headline', (text) => {
        if (gameStatus !== 'WRITING') return;

        const player = players[socket.id];
        if (!player) {
            socket.emit('submit_error', 'שגיאת חיבור. נא לרענן את העמוד.');
            return;
        }

        const currentQIndex = player.headlinesWritten;

        if (currentQIndex < 3) {
            // Check against TRUE answer
            const currentQ = currentRoundData.questions[currentQIndex];
            if (currentQ && isTooSimilar(text, currentQ.missing)) {
                socket.emit('submit_error', 'זה קרוב מדי לאמת! נסו לשקר טוב יותר...');
                return;
            }

            currentRoundData.submissions[currentQIndex].push({
                playerId: player.id, // now matches socket.id
                text: text,
                isReal: false
            });

            player.headlinesWritten++;

            if (player.headlinesWritten < 3) {
                // Send Next Question
                const nextIdx = player.headlinesWritten;
                socket.emit('move_to_writing', {
                    prompt: currentRoundData.questions[nextIdx].prompt,
                    source: currentRoundData.questions[nextIdx].source,
                    questionNum: nextIdx + 1,
                    duration: null
                });
            } else {
                socket.emit('wait_for_others');
            }
        }

        const totalPlayers = Object.keys(players).length;
        const totalSubmissions = currentRoundData.submissions[0].length + currentRoundData.submissions[1].length + currentRoundData.submissions[2].length;

        io.to('host_room').emit('update_submission_count', Math.floor(totalSubmissions / 3));

        if (totalSubmissions === totalPlayers * 3) {
            if (phaseTimeout) clearTimeout(phaseTimeout);
            currentRoundData.votingStep = 0;
            startVotingPhase();
        }

        io.to('host_room').emit('player_done_writing', { playerId: player.id, count: player.headlinesWritten });
    });

    function startVotingPhase() {
        gameStatus = 'VOTING';
        currentRoundData.votes = {};
        currentRoundData.stepResultsShown = false;

        console.log(`Starting Voting Phase for Step ${currentRoundData.votingStep + 1}/3`);

        const step = currentRoundData.votingStep;
        if (!currentRoundData.questions || !currentRoundData.questions[step]) {
            console.error("error step");
            return;
        }
        const question = currentRoundData.questions[step];
        const submissions = currentRoundData.submissions[step];

        const allOptions = [...submissions];
        allOptions.push({ playerId: 'TRUTH', text: question.missing, isReal: true });

        currentRoundData.currentOptions = allOptions.sort(() => Math.random() - 0.5);

        io.to('host_room').emit('start_voting_display', {
            question: question.prompt,
            options: currentRoundData.currentOptions,
            step: step + 1,
            duration: GAME_CONFIG.VOTING_TIME_MS,
            audio: question.audioFile
        });
        io.emit('move_to_voting_screen', {
            options: currentRoundData.currentOptions,
            duration: GAME_CONFIG.VOTING_TIME_MS
        });

        // Set timer for voting phase
        if (phaseTimeout) clearTimeout(phaseTimeout);
        if (warningTimeout) clearTimeout(warningTimeout);

        if (GAME_CONFIG.VOTING_TIME_MS > 10000) {
            warningTimeout = setTimeout(() => {
                io.emit('hurry_up');
            }, GAME_CONFIG.VOTING_TIME_MS - 10000);
        }

        phaseTimeout = setTimeout(() => {
            console.log("Voting time over!");
            finalizeVotingRound();
        }, GAME_CONFIG.VOTING_TIME_MS);
    }

    socket.on('host_next_phase', () => {
        if (gameStatus === 'VOTING') {
            if (currentRoundData.votingStep < 2) {
                currentRoundData.votingStep++;
                currentRoundData.votes = {};
                startVotingPhase();
            } else {
                if (currentRoundNumber === 4) {
                    const sortedPlayers = Object.values(players).sort((a, b) => b.score - a.score);
                    io.to('host_room').emit('game_winner_reveal', sortedPlayers);
                    gameStatus = 'WINNER';
                } else {
                    io.to('host_room').emit('show_leaderboard');
                }
            }
        }
    });

    socket.on('host_truth_revealed', (data) => {
        io.emit('truth_revealed_haptic', { truthIndex: data.truthIndex });
    });

    function finalizeVotingRound() {
        if (phaseTimeout) clearTimeout(phaseTimeout);
        if (warningTimeout) clearTimeout(warningTimeout);

        if (currentRoundData.stepResultsShown) {
            return;
        }

        calculateScores();

        const currentQ = currentRoundData.questions[currentRoundData.votingStep];

        // Players is safe now (no timeouts)
        const results = {
            question: currentQ.prompt,
            original: currentQ.original,
            source: currentQ.source,
            audio: currentQ.audioFile,
            options: currentRoundData.currentOptions,
            votes: currentRoundData.votes,
            players: players,
            isLastStep: (currentRoundData.votingStep === 2)
        };
        io.to('host_room').emit('game_over_results', results);
        currentRoundData.stepResultsShown = true;
    }

    socket.on('submit_vote', (optionIndex) => {
        if (gameStatus !== 'VOTING') return;

        const player = players[socket.id];
        if (!player) return;

        const selectedOption = currentRoundData.currentOptions[optionIndex];
        if (!selectedOption) return;

        if (selectedOption.playerId === player.id) {
            socket.emit('submit_error', 'אסור להצביע לתשובה של עצמך!');
            return;
        }

        currentRoundData.votes[player.id] = optionIndex;
        io.to('host_room').emit('host_player_voted', { playerId: player.id, nickname: player.nickname });

        const activePlayers = Object.keys(players); // All players are active in this mode
        const totalVotes = Object.keys(currentRoundData.votes).length;

        if (totalVotes >= activePlayers.length) {
            finalizeVotingRound();
        }
    });

    socket.on('disconnect', () => {
        console.log('מישהו התנתק:', socket.id);
        const player = players[socket.id];

        if (player) {
            console.log(`Player ${player.nickname} disconnected (keeping data).`);
            player.connected = false;
            // delete players[socket.id]; // DISABLED FOR RECONNECT

            io.to('host_room').emit('player_disconnect', { playerId: socket.id });
            io.to('host_room').emit('update_player_list', Object.values(players));
        }
    });
});

function calculateScores() {
    for (const [voterId, choiceIndex] of Object.entries(currentRoundData.votes)) {
        const selectedOption = currentRoundData.currentOptions[choiceIndex];
        if (!selectedOption) continue;

        if (selectedOption.isReal) {
            const multiplier = (currentRoundNumber === 4) ? 2 : 1;
            const voter = players[voterId];
            if (voter) {
                const points = (10 * multiplier);
                voter.score += points;
                voter.roundScore += points;
            }
        } else {
            const liarId = selectedOption.playerId;
            const multiplier = (currentRoundNumber === 4) ? 2 : 1;
            const liar = players[liarId];
            if (liar) {
                const points = (5 * multiplier);
                liar.score += points;
                liar.roundScore += points;
            }
        }
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
