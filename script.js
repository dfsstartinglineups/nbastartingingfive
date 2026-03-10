let ALL_GAMES_DATA = [];
let ARE_ALL_EXPANDED = false;
let DEFAULT_DATE = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

const TEAM_MAP_FOR_LOGOS = {
    'GS': 'GSW', 'GOLDEN STATE': 'GSW',
    'NO': 'NOP', 'NEW ORLEANS': 'NOP', 'NOH': 'NOP',
    'NY': 'NYK', 'NEW YORK': 'NYK', 'KNICKS': 'NYK',
    'SA': 'SAS', 'SAN ANTONIO': 'SAS', 'SPURS': 'SAS',
    'PHO': 'PHX', 'PHOENIX': 'PHX',
    'UT': 'UTA', 'UTAH': 'UTA', 'JAZZ': 'UTA',
    'WSH': 'WAS', 'WASHINGTON': 'WAS',
    'BKO': 'BKN', 'BROOKLYN': 'BKN',
    'CHO': 'CHA', 'CHARLOTTE': 'CHA'
};

function normalizeName(name) {
    if (!name) return "";
    const nicknames = {
        'cam': 'cameron', 'nic': 'nicolas', 'patti': 'patrick', 'pat': 'patrick',
        'mo': 'moritz', 'moe': 'moritz', 'zach': 'zachary', 'tim': 'timothy',
        'kj': 'kenyon', 'x': 'xavier', 'herb': 'herbert', 'bub': 'carrinton',
        'greg': 'gregory', 'nick': 'nicholas', 'mitch': 'mitchell', 'kelly': 'kelly',
        'pj': 'pj', 'trey': 'trey', 'cj': 'cj', 'c.j.': 'cj', 'shai': 'shai'
    };
    let clean = name.toLowerCase().trim().replace(/['.]/g, '');
    [' jr', ' sr', ' ii', ' iii', ' iv'].forEach(s => {
        if (clean.endsWith(s)) clean = clean.slice(0, -s.length);
    });
    let parts = clean.split(' ');
    if (parts.length > 0 && nicknames[parts[0]]) parts[0] = nicknames[parts[0]];
    return parts.join(' ');
}

function getStandardAbbr(abbr) {
    const upper = abbr.toUpperCase();
    return TEAM_MAP_FOR_LOGOS[upper] || upper;
}

async function fetchLocalProbables() {
    try {
        const ts = new Date().getTime();
        const response = await fetch(`nba_data.json?v=${ts}`);
        if (!response.ok) throw new Error('Local file not found');
        const data = await response.json();
        if (data.last_updated) {
            document.getElementById('update-timestamp').innerText = `Last Updated: ${data.last_updated}`;
        }
        return data.games || [];
    } catch (e) {
        console.log("No local nba_data.json found. Continuing with purely ESPN data.");
        return [];
    }
}

function handleHashNavigation() {
    const hash = window.location.hash;
    if (hash && hash.startsWith('#game-')) {
        setTimeout(() => {
            const targetEl = document.querySelector(hash);
            if (targetEl) {
                targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                
                // Remove existing highlights if any
                document.querySelectorAll('.highlight-flash').forEach(el => {
                    el.classList.remove('highlight-flash');
                });
                
                // Add fresh highlight class to trigger animation
                targetEl.classList.add('highlight-flash');
            }
        }, 300); // 300ms delay to ensure layout is completely stable before scrolling
    }
}

async function init(dateToFetch) {
    document.getElementById('date-picker').value = dateToFetch;
    ALL_GAMES_DATA = [];
    const container = document.getElementById('lineups-container');
    
    if (container.children.length === 0) {
        container.innerHTML = `
            <div class="col-12 text-center mt-5 pt-5">
                <div class="spinner-border text-danger" role="status"></div>
                <p class="mt-3 text-muted fw-bold">Loading Court Data...</p>
            </div>`;
    }
    
    const espnDate = dateToFetch.replace(/-/g, '');
    const ESPN_API_URL = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${espnDate}`;
    
    try {
        const [scheduleResponse, localProbables] = await Promise.all([
            fetch(ESPN_API_URL),
            fetchLocalProbables()
        ]);
        const scheduleData = await scheduleResponse.json();

        if (!scheduleData.events || scheduleData.events.length === 0) {
            container.innerHTML = `<div class="col-12 text-center mt-5"><div class="alert alert-light border shadow-sm py-4"><h5 class="text-muted mb-0">No games scheduled for ${dateToFetch}</h5></div></div>`;
            return;
        }

        const teamIds = new Set();
        scheduleData.events.forEach(game => {
            game.competitions[0].competitors.forEach(c => teamIds.add(c.team.id));
        });

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
            } catch(e) {}
        });
        await Promise.all(rosterPromises);

        scheduleData.events.forEach(game => {
            const comp = game.competitions[0];
            const homeTeamData = comp.competitors.find(c => c.homeAway === 'home');
            const awayTeamData = comp.competitors.find(c => c.homeAway === 'away');
            const homeStd = getStandardAbbr(homeTeamData.team.abbreviation);
            const awayStd = getStandardAbbr(awayTeamData.team.abbreviation);

            // Generate standard EST string (YYYY-MM-DD) for the ESPN Game to match the Python format
            const espnGameDate = new Date(game.date).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

            const localGameMatch = localProbables.find(g => {
                if (!g.teams || g.teams.length < 2) return false;
                const t1 = getStandardAbbr(g.teams[0]);
                const t2 = getStandardAbbr(g.teams[1]);
                
                // Match the teams playing
                const isTeamMatch = (t1 === homeStd || t1 === awayStd) && (t2 === homeStd || t2 === awayStd);
                
                // Match the actual date if the python script has provided it
                const isDateMatch = g.date ? (g.date === espnGameDate) : true;
                
                return isTeamMatch && isDateMatch;
            });

            // Create the ID (Match local exactly, or fallback to the logic python uses)
            const localId = localGameMatch ? localGameMatch.id : `${awayStd}-${homeStd}-${espnGameDate}`;

            let odds = { spread: "TBD", overUnder: "TBD" };
            if (comp.odds && comp.odds.length > 0) {
                odds.spread = comp.odds[0].details || "TBD";
                odds.overUnder = comp.odds[0].overUnder ? `O/U ${comp.odds[0].overUnder}` : "O/U TBD";
            } else if (localGameMatch && localGameMatch.meta) {
                if (localGameMatch.meta.spread && localGameMatch.meta.spread !== "TBD") odds.spread = localGameMatch.meta.spread;
                if (localGameMatch.meta.total && localGameMatch.meta.total !== "TBD") odds.overUnder = `O/U ${localGameMatch.meta.total}`;
            }

            // Lineup Logic
            let awayStarters = [], awayIsProjected = true;
            let localAwayPlayers = (localGameMatch && localGameMatch.rosters && localGameMatch.rosters[awayStd]) ? localGameMatch.rosters[awayStd].players : null;
            if (localAwayPlayers && localAwayPlayers.every(p => p.verified)) {
                awayStarters = localAwayPlayers.map(p => ({ athlete: { displayName: p.name, position: { abbreviation: p.pos }, dfs: p } }));
                awayIsProjected = false;
            } else if (awayTeamData.starters) {
                awayStarters = awayTeamData.starters; awayIsProjected = false;
            } else if (localAwayPlayers) {
                awayStarters = localAwayPlayers.map(p => ({ athlete: { displayName: p.name, position: { abbreviation: p.pos }, dfs: p } }));
            }

            let homeStarters = [], homeIsProjected = true;
            let localHomePlayers = (localGameMatch && localGameMatch.rosters && localGameMatch.rosters[homeStd]) ? localGameMatch.rosters[homeStd].players : null;
            if (localHomePlayers && localHomePlayers.every(p => p.verified)) {
                homeStarters = localHomePlayers.map(p => ({ athlete: { displayName: p.name, position: { abbreviation: p.pos }, dfs: p } }));
                homeIsProjected = false;
            } else if (homeTeamData.starters) {
                homeStarters = homeTeamData.starters; homeIsProjected = false;
            } else if (localHomePlayers) {
                homeStarters = localHomePlayers.map(p => ({ athlete: { displayName: p.name, position: { abbreviation: p.pos }, dfs: p } }));
            }

            [awayStarters, homeStarters].forEach(starters => {
                starters.forEach(p => {
                    const athlete = p.athlete || p;
                    const normName = normalizeName(athlete.displayName || athlete.fullName);
                    if (["Flex", "G", "F", "C"].includes(athlete.position?.abbreviation)) {
                        athlete.position.abbreviation = TRUE_POS_BY_ID[athlete.id] || TRUE_POS_BY_NAME[normName] || athlete.position.abbreviation;
                    }
                });
            });

            ALL_GAMES_DATA.push({
                gameRaw: game, home: homeTeamData, away: awayTeamData,
                homeStarters, awayStarters, homeIsProjected, awayIsProjected,
                odds, venue: comp.venue?.fullName || "TBD",
                gameDate: new Date(game.date), status: game.status.type.detail,
                localId: localId // Exposing to renderer
            });
        });
        
        renderGames();
        handleHashNavigation(); // Fire Deep Link scrolling!
        
    } catch (error) {
        container.innerHTML = `
            <div class="col-12 text-center mt-5">
                <div class="alert alert-danger shadow-sm">
                    <strong>Error loading data.</strong> Please try again later.
                </div>
            </div>`;
    }
}

function renderGames() {
    const container = document.getElementById('lineups-container');
    container.innerHTML = '';
    
    const filterText = (document.getElementById('team-search')?.value || '').toLowerCase();

    ALL_GAMES_DATA.forEach(data => {
        const homeName = data.home.team.displayName.toLowerCase();
        const awayName = data.away.team.displayName.toLowerCase();
        const homeAbbr = data.home.team.abbreviation.toLowerCase();
        const awayAbbr = data.away.team.abbreviation.toLowerCase();

        if (filterText && !homeName.includes(filterText) && !awayName.includes(filterText) && 
            !homeAbbr.includes(filterText) && !awayAbbr.includes(filterText)) {
            return;
        }
        container.appendChild(createGameCard(data));
    });
}

function createGameCard(data) {
    const gameCard = document.createElement('div');
    gameCard.className = 'col-md-6 col-lg-6 col-xl-4 mb-2';
    
    const { away, home, gameRaw } = data;
    const gameState = gameRaw.status.type.state;
    const statusDetail = gameRaw.status.type.shortDetail;

    let scoreOrOddsHtml = "";
    if (gameState === 'in' || gameState === 'post') {
        const scoreColor = gameState === 'in' ? 'text-danger' : 'text-dark';
        scoreOrOddsHtml = `
            <div class="fw-bold ${scoreColor} mb-1" style="font-size: 1.1rem; letter-spacing: -0.5px;">
                ${away.score || 0} - ${home.score || 0}
            </div>
            <div class="badge bg-light text-muted border w-100" style="font-size: 0.7rem;">${statusDetail}</div>`;
    } else {
        scoreOrOddsHtml = `
            <div class="badge bg-light text-dark border w-100 mb-1" style="font-size: 0.75rem;">${data.odds.spread}</div>
            <div class="badge bg-secondary text-white w-100" style="font-size: 0.70rem;">${data.odds.overUnder}</div>`;
    }

    const buildLineupList = (players, isProjected) => {
        if (!players.length) return `<div class="p-4 text-center text-muted small fw-bold">Lineup pending...</div>`;
        const color = isProjected ? "#ffecb5" : "#198754";
        const textColor = isProjected ? "text-dark" : "text-white";
        const label = isProjected ? "⚠️ PROJECTED" : "✅ OFFICIAL";
        
        // Find out which platform is toggled on the UI
        const platformNode = document.querySelector('input[name="dfsPlatform"]:checked');
        const platform = platformNode ? platformNode.value : 'fd';
        
        const items = players.map(p => {
            const a = p.athlete || p;
            let statsHtml = '';
            let injuryHtml = '';
            
            // If we mapped the DFS data to the player, extract it based on platform
            if (a.dfs) {
                const sal = platform === 'dk' ? a.dfs.dk_salary : a.dfs.salary;
                const proj = platform === 'dk' ? a.dfs.dk_proj : a.dfs.proj;
                const val = platform === 'dk' ? a.dfs.dk_value : a.dfs.value;
                const injury = a.dfs.injury;
                
                // Only show stats if they exist
                if (sal > 0 || proj > 0) {
                    const salFormatted = sal > 0 ? `$${sal}` : '-';
                    const projFormatted = proj > 0 ? `${proj} FP` : '-';
                    const valFormatted = val > 0 ? `${val}x` : '-';
                    statsHtml = `<div class="dfs-stats fw-bold">${salFormatted} | ${projFormatted} | ${valFormatted}</div>`;
                }
                
                if (injury && injury !== "") {
                    injuryHtml = `<span class="text-danger fw-bold ms-1" style="font-size:0.6rem;">${injury}</span>`;
                }
            }
            
            return `
            <li class="px-2 py-1 border-bottom small d-flex flex-column align-items-start">
                <div class="d-flex w-100 justify-content-start align-items-center">
                    <span class="text-muted fw-bold me-2">${a.position?.abbreviation || '-'}</span>
                    <span class="fw-bold">${a.displayName || a.fullName}</span>${injuryHtml}
                </div>
                ${statsHtml}
            </li>`;
        }).join('');
        
        return `<div class="text-center py-1 fw-bold ${textColor}" style="font-size: 0.6rem; background-color: ${color};">${label}</div><ul class="list-unstyled m-0">${items}</ul>`;
    };

    // The ID is now attached directly to the .lineup-card div so the highlight effect targets the physical box properly
    gameCard.innerHTML = `
        <div class="lineup-card shadow-sm border rounded bg-white overflow-hidden" id="game-${data.localId}">
            <div class="p-2 border-bottom d-flex justify-content-between align-items-center bg-light">
                <span class="badge bg-dark text-white" style="font-size: 0.7rem;">${data.gameDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                <span class="text-muted fw-bold text-uppercase" style="font-size: 0.6rem;">${data.venue}</span>
            </div>
            <div class="p-2 d-flex align-items-center justify-content-between text-center">
                <div style="width: 35%;"><img src="${away.team.logo}" style="width: 40px;"><div class="fw-bold small">${away.team.shortDisplayName}</div></div>
                <div style="width: 30%;">${scoreOrOddsHtml}</div>
                <div style="width: 35%;"><img src="${home.team.logo}" style="width: 40px;"><div class="fw-bold small">${home.team.shortDisplayName}</div></div>
            </div>
            <div class="row g-0 border-top">
                <div class="col-6 border-end">${buildLineupList(data.awayStarters, data.awayIsProjected)}</div>
                <div class="col-6">${buildLineupList(data.homeStarters, data.homeIsProjected)}</div>
            </div>
        </div>`;
        
    return gameCard;
}

document.addEventListener('DOMContentLoaded', () => {
    init(DEFAULT_DATE);
    document.getElementById('team-search')?.addEventListener('input', renderGames);
    document.getElementById('date-picker')?.addEventListener('change', (e) => {
        init(e.target.value);
        e.target.blur(); // Forces the mobile calendar UI to close immediately upon selection
    });
    
    // Listen for DFS platform toggle changes
    document.querySelectorAll('.dfs-toggle').forEach(radio => {
        radio.addEventListener('change', renderGames);
    });
});
