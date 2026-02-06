const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// --- משתני המשחק ---
let players = {};
let gameStatus = 'LOBBY';
let currentRoundNumber = 0;
const ROOM_CODE = "ABCD";
const GAME_CONFIG = {
    WRITING_TIME_MS: 45000, // 2 minutes (Writing Phase)
    VOTING_TIME_MS: 15000    // 45 seconds (Voting Phase)
};

let phaseTimeout = null;

// מבנה הנתונים לסיבוב הנוכחי
let currentRoundData = {
    questions: [], // יכיל 3 שאלות
    submissions: [[], [], []], // מערך להגשות ל-3 שאלות
    votingStep: 0, // 0-2
    currentOptions: [], // האפשרויות המוצגות כרגע להצבעה
    votes: {}, // מי הצביע למה בסיבוב הנוכחי
    stepResultsShown: false // Prevent re-animation on disconnect
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

// ...

// In finalizeVotingRound (around line 125, need to find it relative to this replacement or do separate chunks)
// Wait, I can't reach finalizeVotingRound easily in one block if they are far apart.
// I'll update parsing first.

// actually finalizeVotingRound needs the 'source' from the question object.
// The currentQuestion object comes from questionsDatabase, so it will already have the 'source' property if I update the parser.
// In finalizeVotingRound:
// const results = { question: ..., original: ..., source: currentQ.source ... }
// I need to confirm finalizeVotingRound includes generic properties or explicit ones.
// In previous edits (Step 326), I explicitly mapped: 
// question: currentQ.prompt, original: currentQ.original
// So I need to add source: currentQ.source there.

// I will use multi_replace for this.

// ...



io.on('connection', (socket) => {
    console.log('מישהו התחבר:', socket.id);

    socket.on('host_connect', () => {
        socket.join('host_room');
        io.to('host_room').emit('update_player_list', Object.values(players));
    });

    socket.on('player_attempt_join', (code) => {
        if (code.toUpperCase() === ROOM_CODE) {
            socket.emit('join_success');
        } else {
            socket.emit('join_error', 'קוד שגוי');
        }
    });

    socket.on('player_register', (data) => {
        players[socket.id] = {
            id: socket.id,
            nickname: data.nickname,
            gender: data.gender,
            favThing: data.favThing,
            favThing: data.favThing,
            journalisticSpecialty: (data.gender === 'male' ? 'כתב לעינייני ' : (data.gender === 'female' ? 'כתבת לעינייני ' : 'כתב/ת לעינייני ')) + data.favThing,
            score: 0,
            headlinesWritten: 0
        };
        io.to('host_room').emit('player_joined', {
            ...players[socket.id],
            journalisticSpecialty: players[socket.id].journalisticSpecialty
        });
    });

    socket.on('host_start_game', () => {
        // Reset Scores for ALL players
        for (let pid in players) {
            players[pid].score = 0;
            players[pid].headlinesWritten = 0; // Ensure clean state
        }

        // Notify clients of score reset? 
        // host.html will get 'host_phase_instructions' which doesn't update the list.
        // But when round starts, 'update_player_list' isn't called automatically.
        // We should emit an update.
        io.to('host_room').emit('update_player_list', Object.values(players));

        // Start Instructions Phase instead of Writing
        currentRoundNumber = 0; // Reset rounds
        gameStatus = 'INSTRUCTIONS';
        io.to('host_room').emit('host_phase_instructions');
    });

    socket.on('host_start_round', () => {
        startNewRound();
    });

    // --- מעבר בין הצבעה 1 להצבעה 2 (או לסיבוב הבא) ---


    function startNewRound() {
        currentRoundNumber++;
        gameStatus = 'WRITING';
        currentRoundData.submissions = [[], [], []];
        currentRoundData.votingStep = 0;
        currentRoundData.votingStep = 0;
        currentRoundData.votes = {};
        currentRoundData.stepResultsShown = false;

        for (let pid in players) {
            players[pid].headlinesWritten = 0;
        }

        // --- Select 3 Questions based on Round Difficulty ---
        // Round 1: 3x Diff 1
        // Round 2: 2x Diff 1, 1x Diff 2
        // Round 3: 3x Diff 2
        // Round 4: 3x Diff 3

        const qConfig = {
            1: { 1: 3, 2: 0, 3: 0 },
            2: { 1: 2, 2: 1, 3: 0 },
            3: { 1: 0, 2: 3, 3: 0 },
            4: { 1: 0, 2: 0, 3: 3 }
        };

        const config = qConfig[currentRoundNumber] || { 1: 3, 2: 0, 3: 0 }; // Default to round 1 if bug

        const selectedIndices = [];

        // Helper to get random unique indices
        const getQuestionsByDiff = (diff, count) => {
            const available = questionsDatabase
                .map((q, idx) => ({ ...q, originalIndex: idx }))
                .filter(q => q.difficulty === diff && !usedQuestionIndices.includes(q.originalIndex));

            // Random shuffle
            for (let i = available.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [available[i], available[j]] = [available[j], available[i]];
            }

            return available.slice(0, count).map(q => q.originalIndex);
        };

        const diff1 = getQuestionsByDiff(1, config[1]);
        const diff2 = getQuestionsByDiff(2, config[2]);
        const diff3 = getQuestionsByDiff(3, config[3]);

        // If not enough questions, what do we do?
        // Fallback: Pick ANY unused if we are short.
        let picked = [...diff1, ...diff2, ...diff3];

        if (picked.length < 3) {
            console.warn("Not enough questions of required difficulty! Filling with randoms.");
            const remaining = 3 - picked.length;
            const extra = getQuestionsByDiff(1, 100).concat(getQuestionsByDiff(2, 100)).concat(getQuestionsByDiff(3, 100)); // Get all unused
            // Filter duplicates already picked
            const extraUnique = extra.filter(idx => !picked.includes(idx));
            picked = picked.concat(extraUnique.slice(0, remaining));
        }

        usedQuestionIndices.push(...picked);
        // Map back to objects
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
            roundNum: currentRoundNumber // Optional for display
        });

        // Set timer for writing phase
        if (phaseTimeout) clearTimeout(phaseTimeout);
        phaseTimeout = setTimeout(() => {
            console.log("Writing time over!");
            // Force move to voting even if submissions missing
            currentRoundData.votingStep = 0;
            startVotingPhase();
        }, GAME_CONFIG.WRITING_TIME_MS);
    }

    // --- בדיקת דמיון לתשובה האמיתית ---
    function normalizeString(str) {
        return str.replace(/[^\w\u0590-\u05FF]/g, '').toLowerCase(); // Remove non-word chars, lowercase
    }

    function isTooSimilar(submission, truth) {
        const normSub = normalizeString(submission);
        const normTruth = normalizeString(truth);

        if (!normSub || !normTruth) return false;

        // Exact match (normalized)
        if (normSub === normTruth) return true;

        // Containment: if one contains the other (and isn't super short)
        // Prevent "Dog" vs "The Dog"
        if (normTruth.length > 2) {
            if (normSub.includes(normTruth) || normTruth.includes(normSub)) return true;
        }

        // Levenshtein or detailed fuzzy matching could go here, 
        // but simple containment covers 90% of "oops I typed the truth" cases
        return false;
    }

    socket.on('submit_headline', (text) => {
        if (gameStatus !== 'WRITING') return; // Ignore if time up

        const player = players[socket.id];
        if (!player) return;

        const currentQIndex = player.headlinesWritten; // 0, 1, or 2

        if (currentQIndex < 3) {
            // Check against TRUE answer
            const currentQ = currentRoundData.questions[currentQIndex];
            if (currentQ && isTooSimilar(text, currentQ.missing)) {
                socket.emit('submit_error', 'זה קרוב מדי לאמת! נסו לשקר טוב יותר...');
                return;
            }

            currentRoundData.submissions[currentQIndex].push({
                playerId: socket.id,
                text: text,
                isReal: false
            });

            player.headlinesWritten++;

            if (player.headlinesWritten < 3) {
                // Send Next Question
                const nextIdx = player.headlinesWritten; // 1 or 2
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
            if (phaseTimeout) clearTimeout(phaseTimeout); // Stop timer
            currentRoundData.votingStep = 0;
            startVotingPhase();
        }

        // Notify Host that this specific player is done with THIS prompt
        // Note: they might have more prompts. But for the animation "Pop" we want to show progress.
        // If they finished 1/2, maybe a small pop? If 2/2, a big checkmark.
        // Let's send the event regardless, frontend decides.
        io.to('host_room').emit('player_done_writing', { playerId: socket.id, count: player.headlinesWritten });
    });

    function startVotingPhase() {
        gameStatus = 'VOTING';
        currentRoundData.votes = {};
        currentRoundData.stepResultsShown = false;

        console.log(`Starting Voting Phase for Step ${currentRoundData.votingStep + 1}/3`);

        const step = currentRoundData.votingStep;
        if (!currentRoundData.questions || !currentRoundData.questions[step]) {
            console.error("CRITICAL ERROR: Question not found for voting step " + step);
            // reset or handle gracefully
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
            audio: question.audioFile // Send audio for TTS
        });
        io.emit('move_to_voting_screen', {
            options: currentRoundData.currentOptions,
            duration: GAME_CONFIG.VOTING_TIME_MS
        });

        // Set timer for voting phase
        if (phaseTimeout) clearTimeout(phaseTimeout);
        phaseTimeout = setTimeout(() => {
            console.log("Voting time over!");
            finalizeVotingRound(); // Force calculation
        }, GAME_CONFIG.VOTING_TIME_MS);
    }

    socket.on('host_next_phase', () => {
        if (gameStatus === 'VOTING') {
            // Check if we are at the end of the round or just a step
            // 3 questions: indices 0, 1, 2.
            if (currentRoundData.votingStep < 2) {
                // Next question
                currentRoundData.votingStep++;
                currentRoundData.votes = {}; // Reset votes for new question
                startVotingPhase();
            } else {
                // Done with all 3 -> Leaderboard
                io.to('host_room').emit('show_leaderboard');
                // gameStatus = 'LEADERBOARD'; // Optional, but good for state tracking
            }
        }
    });

    // New helper to wrap up voting round
    // New helper to wrap up voting round
    function finalizeVotingRound() {
        if (phaseTimeout) clearTimeout(phaseTimeout);

        // Prevent re-emitting and restarting animations if already shown for this step
        if (currentRoundData.stepResultsShown) {
            console.log(`Skipping finalizeVotingRound for step ${currentRoundData.votingStep} - already shown.`);
            return;
        }

        calculateScores();

        const currentQ = currentRoundData.questions[currentRoundData.votingStep];

        const results = {
            question: currentQ.prompt,
            original: currentQ.original, // Send full original text for reveal
            source: currentQ.source,     // Send source for attribution
            audio: currentQ.audioFile,   // TTS for reveal
            options: currentRoundData.currentOptions,
            votes: currentRoundData.votes,
            players: players,
            isLastStep: (currentRoundData.votingStep === 2) // 3 questions means indices 0,1,2. Last is 2.
        };
        io.to('host_room').emit('game_over_results', results);
        currentRoundData.stepResultsShown = true;
        // Note: We don't change gameStatus away from VOTING or anything specific 
        // until host clicks next. Or we could, but displaying results is fine.

    }

    socket.on('submit_vote', (optionIndex) => {
        if (gameStatus !== 'VOTING') return;

        const selectedOption = currentRoundData.currentOptions[optionIndex];
        if (!selectedOption) return;

        // Prevent self-voting
        if (selectedOption.playerId === socket.id) {
            socket.emit('submit_error', 'אסור להצביע לתשובה של עצמך!');
            return;
        }

        if (players[socket.id]) {
            currentRoundData.votes[socket.id] = optionIndex;
            io.to('host_room').emit('host_player_voted', { playerId: socket.id, nickname: players[socket.id].nickname });
        }

        const totalPlayers = Object.keys(players).length;
        const totalVotes = Object.keys(currentRoundData.votes).length;

        if (totalVotes === totalPlayers) {
            finalizeVotingRound();
        }
    });

    socket.on('disconnect', () => {
        if (players[socket.id]) {
            delete players[socket.id];
            // Update player list immediately
            io.to('host_room').emit('update_player_list', Object.values(players));

            // Check if we can proceed with the phase now that the player count changed
            const totalPlayers = Object.keys(players).length;

            if (gameStatus === 'WRITING') {
                const totalSubmissions = currentRoundData.submissions[0].length + currentRoundData.submissions[1].length + currentRoundData.submissions[2].length;
                // Update count display
                io.to('host_room').emit('update_submission_count', Math.floor(totalSubmissions / 3));

                // Check completion (Use >= just in case)
                if (totalPlayers > 0 && totalSubmissions >= totalPlayers * 3) {
                    if (phaseTimeout) clearTimeout(phaseTimeout);
                    currentRoundData.votingStep = 0;
                    startVotingPhase();
                }
            } else if (gameStatus === 'VOTING') {
                const totalVotes = Object.keys(currentRoundData.votes).length;

                // Check completion
                if (totalPlayers > 0 && totalVotes >= totalPlayers) {
                    finalizeVotingRound();
                }
            }
        }
    });
});

function calculateScores() {
    for (const [voterId, choiceIndex] of Object.entries(currentRoundData.votes)) {
        const selectedOption = currentRoundData.currentOptions[choiceIndex];
        if (selectedOption.isReal) {
            const multiplier = (currentRoundNumber === 4) ? 2 : 1;
            if (players[voterId]) players[voterId].score += (10 * multiplier);
        } else {
            const liarId = selectedOption.playerId;
            const multiplier = (currentRoundNumber === 4) ? 2 : 1;
            if (players[liarId]) players[liarId].score += (5 * multiplier);
        }
    }
}

server.listen(3000, '0.0.0.0', () => {
    console.log('Server running on port 3000');
});