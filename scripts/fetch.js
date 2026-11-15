const fs = require('fs');
const path = require('path');

const API_KEY = process.env.API_KEY;
const BASE_URL = 'https://v3.football.api-sports.io';

// --- Fetch today's fixtures ---
async function fetchFixtures() {
  const today = new Date().toISOString().split('T')[0];
  const url = `${BASE_URL}/fixtures?date=${today}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'x-rapidapi-key': API_KEY,
      'x-rapidapi-host': 'v3.football.api-sports.io'
    }
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return data.response || [];
}

// --- Poisson-based prediction engine ---
function calculatePrediction(home, away, oddsHome, oddsDraw, oddsAway) {
  // Simple Poisson model: expected goals based on historical averages
  // For free tier, we use a simplified approach
  const homeStrength = 1.4; // default home advantage
  const awayStrength = 1.0; // default away strength

  const homeExpected = homeStrength * 1.5; // avg goals scored at home
  const awayExpected = awayStrength * 1.2; // avg goals scored away

  // Poisson probability for 0, 1, 2, 3 goals
  function poissonProb(lambda, k) {
    return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k);
  }

  function factorial(n) {
    if (n === 0 || n === 1) return 1;
    let result = 1;
    for (let i = 2; i <= n; i++) result *= i;
    return result;
  }

  // Calculate probabilities for each outcome
  let prob1 = 0, probX = 0, prob2 = 0;
  let probOver25 = 0, probBTTS = 0;

  for (let i = 0; i <= 4; i++) {
    for (let j = 0; j <= 4; j++) {
      const pHome = poissonProb(homeExpected, i);
      const pAway = poissonProb(awayExpected, j);
      const p = pHome * pAway;

      if (i > j) prob1 += p;
      else if (i === j) probX += p;
      else prob2 += p;

      if (i + j > 2.5) probOver25 += p;
      if (i > 0 && j > 0) probBTTS += p;
    }
  }

  // Determine best pick based on probabilities
  const markets = {
    '1X2': {
      pick: prob1 > probX && prob1 > prob2 ? '1' :
            probX > prob1 && probX > prob2 ? 'X' : '2',
      label: prob1 > probX && prob1 > prob2 ? 'Home Win' :
             probX > prob1 && probX > prob2 ? 'Draw' : 'Away Win',
      prob: Math.round(Math.max(prob1, probX, prob2) * 100)
    },
    'Over/Under 2.5': {
      pick: probOver25 > 0.5 ? 'Over 2.5' : 'Under 2.5',
      label: probOver25 > 0.5 ? 'Over 2.5 Goals' : 'Under 2.5 Goals',
      prob: Math.round(probOver25 > 0.5 ? probOver25 * 100 : (1 - probOver25) * 100)
    },
    'Both Teams to Score': {
      pick: probBTTS > 0.5 ? 'Yes' : 'No',
      label: probBTTS > 0.5 ? 'BTTS - Yes' : 'BTTS - No',
      prob: Math.round(probBTTS > 0.5 ? probBTTS * 100 : (1 - probBTTS) * 100)
    }
  };

  // Find best value bet (where model prob > implied odds)
  const implied1 = 1 / oddsHome;
  const impliedX = 1 / oddsDraw;
  const implied2 = 1 / oddsAway;

  let valuePick = null;
  if (prob1 > implied1 * 1.1) valuePick = '1'; // 10% edge
  else if (probX > impliedX * 1.1) valuePick = 'X';
  else if (prob2 > implied2 * 1.1) valuePick = '2';

  return {
    markets,
    valuePick,
    homeExpected: homeExpected.toFixed(2),
    awayExpected: awayExpected.toFixed(2)
  };
}

// --- Determine confidence tier ---
function getConfidence(probability) {
  if (probability >= 65) return 'Banker';
  if (probability >= 55) return 'Solid';
  return 'Brave';
}

// --- Main function ---
async function main() {
  try {
    console.log('Fetching fixtures...');
    const fixtures = await fetchFixtures();

    console.log(`Found ${fixtures.length} fixtures`);

    if (fixtures.length === 0) {
      console.log('No fixtures found for today. Keeping existing data.');
      return;
    }

    // Process each fixture
    const matches = fixtures.map(fixture => {
      const home = fixture.teams.home.name;
      const away = fixture.teams.away.name;
      const league = fixture.leagues.name;
      const time = fixture.fixture.date.split('T')[1].substring(0, 5);
      const oddsHome = fixture.odds?.home || 2.00;
      const oddsDraw = fixture.odds?.draw || 3.50;
      const oddsAway = fixture.odds?.away || 3.50;

      // Calculate predictions
      const predictionData = calculatePrediction(home, away, oddsHome, oddsDraw, oddsAway);

      // Choose best market (default to 1X2)
      const bestMarket = predictionData.markets['1X2'];

      // Check if it's a value bet
      const isValue = predictionData.valuePick !== null;

      return {
        match_id: fixture.fixture.id,
        league: league,
        home: home,
        away: away,
        time: time,
        date: fixture.fixture.date.split('T')[0],
        form: ['🟩', '🟩', '🟨', '⬛', '🟩'], // Placeholder - we'll add real form later
        prediction: {
          market: '1X2',
          pick: bestMarket.pick,
          label: bestMarket.label,
          probability: bestMarket.prob,
          confidence: getConfidence(bestMarket.prob)
        },
        value: isValue,
        odds_home: oddsHome,
        odds_draw: oddsDraw,
        odds_away: oddsAway
      };
    });

    // Save to JSON file
    const outputPath = path.join(__dirname, '..', 'data', 'matches.json');
    fs.writeFileSync(outputPath, JSON.stringify(matches, null, 2));

    console.log(`Updated ${matches.length} matches to ${outputPath}`);
  } catch (error) {
    console.error('Error:', error.message);
    // Don't fail the build if API is down - keep existing data
    process.exit(0);
  }
}

main();
