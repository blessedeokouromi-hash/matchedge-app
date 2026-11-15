const fs = require('fs');
const path = require('path');

const API_KEY = process.env.API_KEY;
const BASE_URL = 'https://api.football-data.org/v4';

// Leagues available on the free tier
const COMPETITIONS = {
  'Premier League': 'PL',
  'La Liga': 'PD',
  'Serie A': 'SA',
  'Bundesliga': 'BL1',
  'Ligue 1': 'FL1',
  'Champions League': 'CL',
  'Europa League': 'EL'
};

// --- Fetch today's fixtures from all competitions ---
async function fetchFixtures() {
  const today = new Date().toISOString().split('T')[0];
  const allMatches = [];

  for (const [name, code] of Object.entries(COMPETITIONS)) {
    try {
      const url = `${BASE_URL}/competitions/${code}/matches?dateFrom=${today}&dateTo=${today}`;
      const response = await fetch(url, {
        headers: { 'X-Auth-Token': API_KEY }
      });

      if (!response.ok) {
        console.log(`Skipping ${name}: ${response.status}`);
        continue; // skip this league, don't crash
      }

      const data = await response.json();
      (data.matches || []).forEach(m => allMatches.push({ ...m, _league: name }));

      // Respect rate limit: 10 requests/minute
      await new Promise(r => setTimeout(r, 6500));
    } catch (err) {
      console.log(`Error fetching ${name}:`, err.message);
    }
  }

  return allMatches;
}

// --- Poisson-based prediction engine ---
function poisson(lambda, k) {
  let fact = 1;
  for (let i = 2; i <= k; i++) fact *= i;
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / fact;
}

function calculatePrediction(oddsHome, oddsDraw, oddsAway) {
  const total = 1 / oddsHome + 1 / oddsDraw + 1 / oddsAway;
  const pHome = (1 / oddsHome) / total;
  const pAway = (1 / oddsAway) / total;

  const homeExpected = 0.8 + pHome * 2.2;
  const awayExpected = 0.7 + pAway * 2.2;

  let prob1 = 0, probX = 0, prob2 = 0, probOver25 = 0, probBTTS = 0;

  for (let i = 0; i <= 5; i++) {
    for (let j = 0; j <= 5; j++) {
      const p = poisson(homeExpected, i) * poisson(awayExpected, j);
      if (i > j) prob1 += p;
      else if (i === j) probX += p;
      else prob2 += p;
      if (i + j > 2.5) probOver25 += p;
      if (i > 0 && j > 0) probBTTS += p;
    }
  }

  const isValue =
    prob1 > (1 / oddsHome) * 1.1 ||
    probX > (1 / oddsDraw) * 1.1 ||
    prob2 > (1 / oddsAway) * 1.1;

  return { prob1, probX, prob2, probOver25, probBTTS, isValue };
}

function getConfidence(probability) {
  if (probability >= 65) return 'Banker';
  if (probability >= 55) return 'Solid';
  return 'Brave';
}

// --- Main ---
async function main() {
  try {
    console.log('Fetching fixtures from Football-Data.org...');
    const fixtures = await fetchFixtures();
    console.log(`Found ${fixtures.length} fixtures`);

    if (fixtures.length === 0) {
      console.log('No fixtures found. Keeping existing data.');
      return;
    }

    const matches = fixtures.map((f, idx) => {
      const home = f.homeTeam?.name || 'TBD';
      const away = f.awayTeam?.name || 'TBD';

      const oddsHome = f.odds?.home ?? 2.20;
      const oddsDraw = f.odds?.draw ?? 3.30;
      const oddsAway = f.odds?.away ?? 3.20;

      const pred = calculatePrediction(oddsHome, oddsDraw, oddsAway);

      const best = Math.max(pred.prob1, pred.probX, pred.prob2);
      const pick = best === pred.prob1 ? '1' : best === pred.probX ? 'X' : '2';
      const label = best === pred.prob1 ? 'Home Win' : best === pred.probX ? 'Draw' : 'Away Win';
      const probability = Math.round(best * 100);

      const utcTime = (f.utcDate || '').split('T')[1]?.substring(0, 5) || '--:--';

      return {
        match_id: f.id || idx,
        league: f._league,
        home,
        away,
        time: utcTime,
        date: (f.utcDate || '').split('T')[0],
        form: ['🟩', '🟨', '🟩', '⬛', '🟩'], // placeholder until Step 5
        prediction: {
          market: '1X2',
          pick,
          label,
          probability,
          confidence: getConfidence(probability)
        },
        value: pred.isValue,
        odds_home: oddsHome,
        odds_draw: oddsDraw,
        odds_away: oddsAway
      };
    });

    const outputPath = path.join(__dirname, '..', 'data', 'matches.json');
    fs.writeFileSync(outputPath, JSON.stringify(matches, null, 2));
    console.log(`Saved ${matches.length} matches.`);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(0); // keep old data instead of breaking site
  }
}

main();
