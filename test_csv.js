const fs = require('fs');
const path = require('path');

function loadQuestionsFromCSV() {
    try {
        const csvPath = path.join(__dirname, 'questions.csv');
        console.log("Reading CSV from:", csvPath);
        const fileContent = fs.readFileSync(csvPath, 'utf8');
        console.log("File content length:", fileContent.length);

        const lines = fileContent.trim().split(/\r?\n/);
        console.log("Total lines:", lines.length);

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

            if (row.length >= 2) {
                const q = {
                    prompt: row[0],
                    missing: row[1],
                    original: row[2] || row[0].replace('____', row[1]),
                    source: row[3] || ''
                };
                questions.push(q);
                // Debug the first few
                if (questions.length <= 3) {
                    console.log(`Parsed Q${questions.length}:`, JSON.stringify(q, null, 2));
                }
            } else {
                console.log("Skipped invalid row:", row);
            }
        }
        return questions;
    } catch (err) {
        console.error("Error loading CSV:", err);
        return [];
    }
}

loadQuestionsFromCSV();
