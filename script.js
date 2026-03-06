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

// THE ROSETTA STONE: Translates ESPN's 2-letter codes into standard 3-letter NBA codes
function getStandardAbbr(abbr) {
    if (!abbr) return "";
    const map = {
        "NY": "NYK",
        "NO": "NOP",
        "SA": "SAS",
        "GS": "GSW",
        "WSH": "WAS",
        "UTAH": "UTA"
    };
    const upper = abbr.toUpperCase();
    return map[upper] || upper;
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

            const homeStd = getStandardAbbr(homeAbbr);
            const awayStd = getStandardAbbr(awayAbbr);

            // Odds
            let odds = { spread: "TBD", overUnder: "TBD" };
            if (comp.odds && comp.odds.length > 0) {
                odds.spread = comp.odds[0].details || "TBD";
                odds.overUnder = comp.odds[0].overUnder ? `O/U ${comp.odds[0].overUnder}` : "O/U TBD";
            }

            // Find matching local game using the Rosetta Stone Map
            const localGameMatch = localProbables.find(g => {
                if (!g.teams || g.teams.length < 2) return false;
                const t1 = getStandardAbbr(g.teams[0]);
                const t2 = getStandardAbbr(g.teams[1]);
                return (t1 === homeStd || t1 === awayStd) && (t2 === homeStd || t2 === awayStd);
            });

            let localAwayKey = null;
            let localHomeKey = null;

            if (localGameMatch) {
                localAwayKey = localGameMatch.teams.find(t => getStandardAbbr(t) === awayStd);
                localHomeKey = localGameMatch.teams.find(t => getStandardAbbr(t) === homeStd);
            }

            // --- OFFICIAL VS PROJECTED LOGIC ---
            let awayIsProjected = true;
            let awayStarters = [];

            // 1. Check Local JSON first
            let localAwayPlayers = (localGameMatch && localGameMatch.rosters && localAwayKey && localGameMatch.rosters[localAwayKey]) ? localGameMatch.rosters[localAwayKey].players : null;
            
            // Validate if ALL players in the local JSON are verified
            let isLocalAwayVerified = localAwayPlayers && localAwayPlayers.length > 0 ? localAwayPlayers.every(p => p.verified === true) : false;

            if (isLocalAwayVerified) {
                awayStarters = localAwayPlayers.map(p => ({
                    athlete: { displayName: p.name, position: { abbreviation: p.pos } }
                }));
                awayIsProjected = false; // Tier 1: Local Custom Verified (Official)
            } else if (awayTeamData.starters && awayTeamData.starters.length > 0) {
                awayStarters = awayTeamData.starters;
                awayIsProjected = false; // Tier 2: Official ESPN Starters
            } else if (localAwayPlayers && localAwayPlayers.length > 0) {
                awayStarters = localAwayPlayers.map(p => ({
                    athlete: { displayName: p.name, position: { abbreviation: p.pos } }
                }));
                awayIsProjected = true;  // Tier 3: Local Custom Projections
            } else if (awayTeamData.probables && awayTeamData.probables.length > 0) {
                awayStarters = awayTeamData.probables;
                awayIsProjected = true;  // Tier 4: ESPN Fallback Projections
            }


            let homeIsProjected = true;
            let homeStarters = [];

            let localHomePlayers = (localGameMatch && localGameMatch.rosters && localHomeKey && localGameMatch.rosters[localHomeKey]) ? localGameMatch.rosters[localHomeKey].players : null;
            let isLocalHomeVerified = localHomePlayers && localHomePlayers.length > 0 ? localHomePlayers.every(p => p.verified === true) : false;

            if (isLocalHomeVerified) {
                homeStarters = localHomePlayers.map(p => ({
                    athlete: { displayName: p.name, position: { abbreviation: p.pos } }
                }));
                homeIsProjected = false; // Tier 1: Local Custom Verified (Official)
            } else if (homeTeamData.starters && homeTeamData.starters.length > 0) {
                homeStarters = homeTeamData.starters;
                homeIsProjected = false; // Tier 2: Official ESPN Starters
            } else if (localHomePlayers && localHomePlayers.length > 0) {
                homeStarters = localHomePlayers.map(p => ({
                    athlete: { displayName: p.name, position: { abbreviation: p.pos } }
                }));
                homeIsProjected = true;  // Tier 3: Local Custom Projections
            } else if (homeTeamData.probables && homeTeamData.probables.length > 0) {
                homeStarters = homeTeamData.probables;
                homeIsProjected = true;  // Tier 4: ESPN Fallback Projections
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
                         if (timeMachineStarters.length > 0) { awayStarters = timeMachineStarters; awayIsProjected = false; }
                    }
                    
                    const homeBox = playersBox.find(p => p.team.id === homeTeamData.team.id);
                    if (homeBox && homeBox.statistics && homeBox.statistics[0].athletes) {
                         const timeMachineStarters = homeBox.statistics[0].athletes.filter(a => a.starter).map(a => a.athlete);
                         if (timeMachineStarters.length > 0) { homeStarters = timeMachineStarters; homeIsProjected = false; }
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

                    // Only overwrite generic/missing positions. 
                    if (athlete.position.abbreviation === "Flex" || athlete.position.abbreviation === "G" || athlete.position.abbreviation === "F" || athlete.position.abbreviation === "C") {
                        if (TRUE_POS_BY_ID[pId]) {
                            athlete.position.abbreviation = TRUE_POS_BY_ID[pId];
                        } else if (TRUE_POS_BY_NAME[normName]) {
                            athlete.position.abbreviation = TRUE_POS_BY_NAME[normName];
                        } else if (athlete.position.abbreviation === 'Flex') {
                            athlete.position.abbreviation = 'F/G';
                        }
                    }
                });
            });

            ALL_GAMES_DATA.push({
                gameRaw: game,
                home: homeTeamData,
                away: awayTeamData,
                homeStarters: homeStarters,
                awayStarters: awayStarters,
                homeIsProjected: homeIsProjected,
                awayIsProjected: awayIsProjected,
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
    const generateTweetText = (teamName, players, opponent, isProjected) => {
        const statusText = isProjected ? "Projected Starting Five" : "Official Starting Five";
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
    const buildLineupList = (playersArray, isProjected) => {
        if (!playersArray || playersArray.length === 0) return `<div class="p-4 text-center text-muted small fw-bold">Lineup pending...</div>`;
        
        let headerHtml = "";
        if (isProjected) {
            headerHtml = `<div class="w-100 text-center py-1 fw-bold text-dark" style="font-size: 0.65rem; background-color: #ffecb5; border-bottom: 1px solid #ffe69c; letter-spacing: 0.5px;">⚠️ PROJECTED</div>`;
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

    const awayLineupHtml = buildLineupList(data.awayStarters, data.awayIsProjected);
    const homeLineupHtml = buildLineupList(data.homeStarters, data.homeIsProjected);

    const X_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" class="x-icon" viewBox="0 0 16 16"><path d="${X_SVG_PATH}"/></svg>`;
    
    const awayTweetText = generateTweetText(awayName, data.awayStarters, homeName, data.awayIsProjected);
    const awayTweetBtn = `<button class="x-btn tweet-trigger" data-tweet="${encodeURIComponent(awayTweetText)}">${X_ICON_SVG}</button>`;
    
    const homeTweetText = generateTweetText(homeName, data.homeStarters, awayName, data.homeIsProjected);
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
