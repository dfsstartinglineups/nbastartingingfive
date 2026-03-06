// ==========================================
// CONFIGURATION
// ==========================================
const DEFAULT_DATE = new Date().toLocaleDateString('en-CA');
let ALL_GAMES_DATA = []; 

const X_SVG_PATH = "M12.6.75h2.454l-5.36 6.142L16 15.25h-4.937l-3.867-5.07-4.425 5.07H.316l5.733-6.57L0 .75h5.063l3.495 4.633L12.601.75Zm-.86 13.028h1.36L4.323 2.145H2.865l8.875 11.633Z";

// ==========================================
// 1. MAIN APP LOGIC 
// ==========================================

// Helper to match local JSON names with ESPN names (removes accents, spaces, punctuation)
function normalizeName(name) {
    if (!name) return "";
    return name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z]/g, "").toLowerCase();
}

async function fetchLocalProbables() {
    try {
        console.log("Checking for local nba_data.json...");
        const response = await fetch('nba_data.json?v=' + new Date().getTime());
        if (response.ok) {
            const data = await response.json();
            return data.games || [];
        }
    } catch (e) {
        console.log("No local nba_data.json found. Defaulting to ESPN only.");
    }
    return [];
}

async function init(dateToFetch) {
    if (window.updateSEO) window.updateSEO(dateToFetch);
    
    const container = document.getElementById('games-container');
    const datePicker = document.getElementById('date-picker');
    
    ALL_GAMES_DATA = [];
    if (datePicker) datePicker.value = dateToFetch;

    if (container) {
        container.innerHTML = `
            <div class="col-12 text-center mt-5 pt-5">
                <div class="spinner-border text-danger" role="status"></div>
                <p class="mt-3 text-muted fw-bold">Loading Court Data...</p>
            </div>`;
    }
    
    // Format date for ESPN API (YYYYMMDD)
    const espnDate = dateToFetch.replace(/-/g, '');
    const ESPN_API_URL = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${espnDate}`;
    
    try {
        // Fetch BOTH ESPN and your local JSON simultaneously
        const [scheduleResponse, localProbables] = await Promise.all([
            fetch(ESPN_API_URL),
            fetchLocalProbables()
        ]);
        
        const scheduleData = await scheduleResponse.json();

        if (!scheduleData.events || scheduleData.events.length === 0) {
            container.innerHTML = `<div class="col-12 text-center mt-5"><div class="alert alert-light border shadow-sm py-4"><h5 class="text-muted mb-0">No games scheduled for ${dateToFetch}</h5></div></div>`;
            return;
        }

        const rawGames = scheduleData.events;

        // --- TRUE POSITION ENGINE ---
        const teamIds = new Set();
        rawGames.forEach(game => {
            const comp = game.competitions[0];
            comp.competitors.forEach(c => teamIds.add(c.team.id));
        });

        // We build TWO dictionaries: One for IDs (ESPN), One for Names (Local JSON)
        const TRUE_POS_BY_ID = {};
        const TRUE_POS_BY_NAME = {};
        
        const rosterPromises = Array.from(teamIds).map(async (teamId) => {
            try {
                const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${teamId}?enable=roster`);
                const data = await res.json();
                
                if (data.team && data.team.athletes) {
                    data.team.athletes.forEach(p => {
                        if (p.position && p.position.abbreviation) {
                            TRUE_POS_BY_ID[String(p.id)] = p.position.abbreviation;
                            
                            const normName = normalizeName(p.displayName || p.fullName);
                            TRUE_POS_BY_NAME[normName] = p.position.abbreviation;
                        }
                    });
                }
            } catch(e) { console.log(`Failed to load roster for team ${teamId}`); }
        });
        
        await Promise.all(rosterPromises);

        for (let i = 0; i < rawGames.length; i++) {
            const game = rawGames[i];
            const comp = game.competitions[0];
            
            const homeTeamData = comp.competitors.find(c => c.homeAway === 'home');
            const awayTeamData = comp.competitors.find(c => c.homeAway === 'away');
            
            const homeAbbr = homeTeamData.team.abbreviation;
            const awayAbbr = awayTeamData.team.abbreviation;

            // Odds
            let odds = { spread: "TBD", overUnder: "TBD" };
            if (comp.odds && comp.odds.length > 0) {
                odds.spread = comp.odds[0].details || "TBD";
                odds.overUnder = comp.odds[0].overUnder ? `O/U ${comp.odds[0].overUnder}` : "O/U TBD";
            }

            // Find matching local game from nba_data.json
            const localGameMatch = localProbables.find(g => 
                g.teams && g.teams.includes(homeAbbr) && g.teams.includes(awayAbbr)
            );

            // --- OFFICIAL VS PROBABLE LOGIC ---
            let awayIsProbable = false;
            let awayStarters = [];
            
            if (awayTeamData.starters && awayTeamData.starters.length > 0) {
                // 1. Official ESPN Starters exist
                awayStarters = awayTeamData.starters;
            } else if (localGameMatch && localGameMatch.rosters && localGameMatch.rosters[awayAbbr]) {
                // 2. Use your local nba_data.json
                awayStarters = localGameMatch.rosters[awayAbbr].players.map(p => ({
                    athlete: { displayName: p.name, position: { abbreviation: p.pos } }
                }));
                awayIsProbable = true;
            } else if (awayTeamData.probables && awayTeamData.probables.length > 0) {
                // 3. Fallback to ESPN Probables
                awayStarters = awayTeamData.probables;
                awayIsProbable = true;
            }

            let homeIsProbable = false;
            let homeStarters = [];
            
            if (homeTeamData.starters && homeTeamData.starters.length > 0) {
                homeStarters = homeTeamData.starters;
            } else if (localGameMatch && localGameMatch.rosters && localGameMatch.rosters[homeAbbr]) {
                homeStarters = localGameMatch.rosters[homeAbbr].players.map(p => ({
                    athlete: { displayName: p.name, position: { abbreviation: p.pos } }
                }));
                homeIsProbable = true;
            } else if (homeTeamData.probables && homeTeamData.probables.length > 0) {
                homeStarters = homeTeamData.probables;
                homeIsProbable = true;
            }

            // --- THE TIME MACHINE (Historical Games Override) ---
            if (game.status.type.state === 'post') {
                try {
                    const summaryRes = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${game.id}`);
                    const summaryData = await summaryRes.json();
                    const playersBox = summaryData.boxscore?.players || [];
                    
                    const awayBox = playersBox.find(p => p.team.id === awayTeamData.team.id);
                    if (awayBox && awayBox.statistics && awayBox.statistics[0].athletes) {
                         const timeMachineStarters = awayBox.statistics[0].athletes.filter(a => a.starter).map(a => a.athlete);
                         if (timeMachineStarters.length > 0) { awayStarters = timeMachineStarters; awayIsProbable = false; }
                    }
                    
                    const homeBox = playersBox.find(p => p.team.id === homeTeamData.team.id);
                    if (homeBox && homeBox.statistics && homeBox.statistics[0].athletes) {
                         const timeMachineStarters = homeBox.statistics[0].athletes.filter(a => a.starter).map(a => a.athlete);
                         if (timeMachineStarters.length > 0) { homeStarters = timeMachineStarters; homeIsProbable = false; }
                    }
                } catch (e) {}
            }

            // --- INJECT TRUE POSITIONS ---
            // Resolves "Flex", "G", "F", "C" into exact positions using Name or ID
            [awayStarters, homeStarters].forEach(starters => {
                starters.forEach(p => {
                    const athlete = p.athlete || p;
                    const pId = String(athlete.id);
                    const normName = normalizeName(athlete.displayName || athlete.fullName);

                    if (!athlete.position) athlete.position = { abbreviation: "-" };

                    if (TRUE_POS_BY_ID[pId]) {
                        athlete.position.abbreviation = TRUE_POS_BY_ID[pId];
                    } else if (TRUE_POS_BY_NAME[normName]) {
                        athlete.position.abbreviation = TRUE_POS_BY_NAME[normName];
                    } else if (athlete.position.abbreviation === 'Flex') {
                        // Clean fallback if the player couldn't be matched
                        athlete.position.abbreviation = 'F/G';
                    }
                });
            });

            ALL_GAMES_DATA.push({
                gameRaw: game,
                home: homeTeamData,
                away: awayTeamData,
                homeStarters: homeStarters,
                awayStarters: awayStarters,
                homeIsProbable: homeIsProbable,
                awayIsProbable: awayIsProbable,
                odds: odds,
                venue: comp.venue?.fullName || "TBD",
                gameDate: new Date(game.date),
                status: game.status.type.detail
            });
        }
        renderGames();
    } catch (error) {
        container.innerHTML = `<div class="col-12 text-center mt-5"><div class="alert alert-danger">Failed to load schedule.</div></div>`;
    }
}

// ==========================================
// 2. RENDERING ENGINE
// ==========================================
function renderGames() {
    const container = document.getElementById('games-container');
    container.innerHTML = '';

    const searchInput = document.getElementById('team-search');
    const searchText = searchInput ? searchInput.value.toLowerCase() : '';

    let filteredGames = ALL_GAMES_DATA.filter(item => {
        const matchString = (item.away.team.displayName + " " + item.home.team.displayName).toLowerCase();
        return matchString.includes(searchText);
    });

    if (filteredGames.length === 0) {
        container.innerHTML = `<div class="col-12 text-center py-5 text-muted fw-bold">No games match your search.</div>`;
        return;
    }

    let sortedGames = [...filteredGames].sort((a, b) => a.gameDate - b.gameDate);
    sortedGames.forEach(item => container.appendChild(createGameCard(item)));
}

function createGameCard(data) {
    const gameCard = document.createElement('div');
    gameCard.className = 'col-md-6 col-lg-6 col-xl-4 mb-2';
    gameCard.id = `game-${data.gameRaw.id}`;

    const away = data.away;
    const home = data.home;
    
    const awayName = away.team.shortDisplayName;
    const homeName = home.team.shortDisplayName;
    const awayLogo = away.team.logo;
    const homeLogo = home.team.logo;
    const awayRecord = away.records?.[0]?.summary || "0-0";
    const homeRecord = home.records?.[0]?.summary || "0-0";

    const gameTime = data.gameDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    const gameDateShort = data.gameDate.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });

    // --- TWITTER EXPORT ---
    const generateTweetText = (teamName, players, opponent, isProbable) => {
        const statusText = isProbable ? "Projected Starting Five" : "Official Starting Five";
        let text = `🏀 ${gameDateShort} ${teamName} ${statusText}\nvs ${opponent}\n\n`;
        
        if(players && players.length > 0) {
            const playerStrings = players.map(p => {
                const athlete = p.athlete || p;
                return `${athlete.position?.abbreviation || '-'} ${athlete.displayName || athlete.fullName}`;
            });
            text += playerStrings.join('\n'); 
        } else {
            text += "Lineup not yet announced.\n";
        }
        const teamHash = teamName.replace(/\s+/g, '');
        text += `\n\nFull matchups & odds: https://nbastartingfive.com/#game-${data.gameRaw.id}\n\n#${teamHash} #${teamHash}Lineup #NBA #DFS #StartingFive`;
        return text;
    };

    // --- LINEUP LIST BUILDER ---
    const buildLineupList = (playersArray, isProbable) => {
        if (!playersArray || playersArray.length === 0) return `<div class="p-4 text-center text-muted small fw-bold">Lineup pending...</div>`;
        
        // Render the Official vs Probable Banner
        let headerHtml = "";
        if (isProbable) {
            headerHtml = `<div class="w-100 text-center py-1 fw-bold text-dark" style="font-size: 0.65rem; background-color: #ffecb5; border-bottom: 1px solid #ffe69c; letter-spacing: 0.5px;">⚠️ PROBABLE</div>`;
        } else {
            headerHtml = `<div class="w-100 text-center py-1 fw-bold text-white" style="font-size: 0.65rem; background-color: #198754; border-bottom: 1px solid #146c43; letter-spacing: 0.5px;">✅ OFFICIAL</div>`;
        }

        const listItems = playersArray.map((athleteWrapper) => {
            const athlete = athleteWrapper.athlete || athleteWrapper;
            let pos = athlete.position?.abbreviation || "-";
            let name = athlete.displayName || athlete.fullName;
            return `
                <li class="d-flex flex-column w-100 px-2 py-1 border-bottom">
                    <div class="d-flex justify-content-between align-items-center w-100 player-toggle" style="cursor: pointer;">
                        <div class="text-truncate pe-1">
                            <span class="text-muted fw-bold d-inline-block text-start" style="font-size: 0.7rem; width: 25px;">${pos}</span>
                            <span class="batter-name fw-bold text-dark" style="font-size: 0.85rem;" title="${name}">${name}</span>
                        </div>
                        <div><span class="badge bg-light text-secondary border toggle-icon" style="width: 24px;">+</span></div>
                    </div>
                </li>`;
        }).join('');
        
        return `${headerHtml}<ul class="batting-order w-100 m-0 p-0" style="list-style-type: none;">${listItems}</ul>`;
    };

    const awayLineupHtml = buildLineupList(data.awayStarters, data.awayIsProbable);
    const homeLineupHtml = buildLineupList(data.homeStarters, data.homeIsProbable);

    const X_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" class="x-icon" viewBox="0 0 16 16"><path d="${X_SVG_PATH}"/></svg>`;
    
    const awayTweetText = generateTweetText(awayName, data.awayStarters, homeName, data.awayIsProbable);
    const awayTweetBtn = `<button class="x-btn tweet-trigger" data-tweet="${encodeURIComponent(awayTweetText)}">${X_ICON_SVG}</button>`;
    
    const homeTweetText = generateTweetText(homeName, data.homeStarters, awayName, data.homeIsProbable);
    const homeTweetBtn = `<button class="x-btn tweet-trigger" data-tweet="${encodeURIComponent(homeTweetText)}">${X_ICON_SVG}</button>`;

    gameCard.innerHTML = `
        <div class="lineup-card shadow-sm" style="margin-bottom: 8px;">
            <div class="p-2 pb-1" style="background-color: #fcfcfc;">
                
                <div class="d-flex align-items-center mb-2 w-100 pb-1 border-bottom border-light">
                    <div style="flex: 0 0 auto;" class="pe-2">
                        <span class="badge bg-dark text-white shadow-sm border px-2 py-1" style="font-size: 0.75rem;">${gameTime}</span>
                    </div>
                    <div class="text-muted fw-bold text-uppercase text-end ms-auto" style="font-size: 0.70rem; letter-spacing: 0.5px;">
                        ${data.venue}
                    </div>
                </div>
                
                <div class="d-flex justify-content-between align-items-center px-1 pt-1 pb-2">
                    <div class="text-center" style="width: 35%;"> 
                        <img src="${awayLogo}" alt="${awayName}" class="team-logo mb-1">
                        <div class="fw-bold lh-1 text-dark d-flex justify-content-center align-items-center flex-wrap" style="font-size: 0.9rem; letter-spacing: -0.2px;">${awayName}</div>
                        <div class="text-muted mt-1" style="font-size:0.7rem;">(${awayRecord})</div>
                    </div>
                    <div class="text-center d-flex flex-column align-items-center justify-content-center" style="width: 30%;">
                        <div class="badge bg-light text-dark border w-100 mb-1" style="font-size: 0.75rem; white-space: nowrap;">${data.odds.spread}</div>
                        <div class="badge bg-secondary text-white w-100" style="font-size: 0.70rem;">${data.odds.overUnder}</div>
                    </div>
                    <div class="text-center" style="width: 35%;"> 
                        <img src="${homeLogo}" alt="${homeName}" class="team-logo mb-1">
                        <div class="fw-bold lh-1 text-dark d-flex justify-content-center align-items-center flex-wrap" style="font-size: 0.9rem; letter-spacing: -0.2px;">${homeName}</div>
                        <div class="text-muted mt-1" style="font-size:0.7rem;">(${homeRecord})</div>
                    </div>
                </div>
            </div>

            <div class="bg-light border-top border-bottom d-flex justify-content-between align-items-center px-2 py-1">
                <div>${awayTweetBtn}</div>
                <div><button class="btn btn-sm btn-link text-decoration-none card-toggle-btn fw-bold text-muted py-0 m-0" style="font-size: 0.7rem;">[+] Matchup Stats</button></div>
                <div>${homeTweetBtn}</div>
            </div>
            
            <div class="row g-0 bg-white">
                <div class="col-6 border-end">${awayLineupHtml}</div>
                <div class="col-6">${homeLineupHtml}</div>
            </div>
        </div>`;
    
    gameCard.querySelectorAll('.tweet-trigger').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation(); 
            openTweetModal(decodeURIComponent(btn.getAttribute('data-tweet')));
        });
    });

    return gameCard;
}

function openTweetModal(text) {
    const modalEl = document.getElementById('tweetModal');
    const textarea = document.getElementById('tweet-textarea');
    if(modalEl && textarea) {
        textarea.value = text;
        new bootstrap.Modal(modalEl).show();
    }
}

// ==========================================
// 3. LISTENERS
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    init(DEFAULT_DATE);

    const searchInput = document.getElementById('team-search');
    if (searchInput) searchInput.addEventListener('input', renderGames);

    const datePicker = document.getElementById('date-picker');
    if (datePicker) {
        datePicker.value = DEFAULT_DATE;
        datePicker.addEventListener('change', (e) => {
            if (e.target.value) { e.target.blur(); init(e.target.value); }
        });
    }

    const copyBtn = document.getElementById('copy-tweet-btn');
    if(copyBtn) {
        copyBtn.addEventListener('click', () => {
            const textarea = document.getElementById('tweet-textarea');
            textarea.select();
            navigator.clipboard.writeText(textarea.value).then(() => {
                const originalText = copyBtn.innerHTML;
                copyBtn.innerHTML = "✅ Copied to Clipboard!";
                copyBtn.classList.replace('btn-dark', 'btn-success');
                setTimeout(() => {
                    copyBtn.innerHTML = originalText;
                    copyBtn.classList.replace('btn-success', 'btn-dark');
                }, 2000);
            }).catch(err => alert("Failed to copy to clipboard."));
        });
    }
});
