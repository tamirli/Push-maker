const fs = require('fs');
const path = require('path');

const csvPath = path.join(__dirname, 'questions.csv');
const jsPath = path.join(__dirname, 'questions.js');

function loadQuestionsFromCSV() {
    try {
        const fileContent = fs.readFileSync(csvPath, 'utf8');
        const lines = fileContent.trim().split(/\r?\n/);

        if (lines.length < 2) return [];

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
                        j++;
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
            row.push(currentField);

            // Correct Mapping: Index(0), Original(1), Prompt(2), Missing(3), Source(4)
            if (row.length >= 4) {
                questions.push({
                    prompt: row[2],
                    missing: row[3],
                    original: row[1],
                    source: row[4] || ''
                });
            }
        }
        return questions;
    } catch (err) {
        console.error("Error loading CSV:", err);
        return [];
    }
}

const questions = loadQuestionsFromCSV();
if (questions.length > 0) {
    const content = `const questionsDatabase = ${JSON.stringify(questions, null, 4)};\n\nmodule.exports = { questionsDatabase };\n`;
    fs.writeFileSync(jsPath, content);
    console.log(`Successfully synced questions.js with ${questions.length} questions.`);
} else {
    console.error("Failed to parse questions or empty.");
}
