// ==========================================
// CONFIGURATION
// ==========================================
const DEFAULT_DATE = new Date().toLocaleDateString('en-CA');
let ALL_GAMES_DATA = []; 

const X_SVG_PATH = "M12.6.75h2.454l-5.36 6.142L16 15.25h-4.937l-3.867-5.07-4.425 5.07H.316l5.733-6.57L0 .75h5.063l3.495 4.633L12.601.75Zm-.86 13.028h1.36L4.323 2.145H2.865l8.875 11.633Z";

// ==========================================
// 1. MAIN APP LOGIC 
// ==========================================

function normalizeName(name) {
    if (!name) return "";
    return name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z]/g, "").toLowerCase();
}

function getStandardAbbr(abbr) {
    if (!abbr) return "";
    let cleanAbbr = abbr.replace(/[^A-Za-z]/g, '').toUpperCase();
    const map = {
        "NY": "NYK", "NO": "NOP", "SA": "SAS", "GS": "GSW", "WSH": "WAS", "UTAH": "UTA"
    };
    return map[cleanAbbr] || cleanAbbr;
}

async function fetchLocalProbables() {
    try {
        const response = await fetch('nba_data.json?v=' + new Date().getTime());
        if (response.ok) {
            const data = await response.json();
            return data.games || [];
        }
    } catch (e) {
        console.log("No local nba_data.json found.");
    }
    return [];
}

// ==========================================
// 2. DEEP LINK SCROLLING (NBA RED THEME)
// ==========================================
function handleHashNavigation() {
    if (window.location.hash) {
        setTimeout(() => {
            // Remove the '#' to get the pure ID
            const targetId = window.location.hash.substring(1);
            const targetCard = document.getElementById(targetId);
            
            if (targetCard) {
                // Scroll the card into the center of the view
                targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
                
                const innerHeader = targetCard.querySelector('.bg-light'); // Grab the top header row
                
                // Apply the bold RED highlight and slight zoom directly to the card
                targetCard.style.transition = 'all 0.4s ease-out';
                targetCard.style.transform = 'scale(1.02)';
                
                // Force overrides on Bootstrap's utility classes
                targetCard.style.setProperty('border', '3px solid #dc3545', 'important');
                targetCard.style.setProperty('box-shadow', '0 0 25px rgba(220, 53, 69, 0.8)', 'important');
                
                targetCard.style.position = 'relative'; // Ensure z-index stacks properly
                targetCard.style.zIndex = '10';
                
                // Temporarily turn the header slightly red to make it pop
                if (innerHeader) {
                    innerHeader.classList.remove('bg-light');
                    innerHeader.style.transition = 'background-color 0.4s ease-out';
                    innerHeader.style.backgroundColor = '#f8d7da'; // Bootstrap light red
                }
                
                // Hold the red highlight for 4 seconds, then fade it back to normal
                setTimeout(() => {
                    targetCard.style.transform = 'scale(1)';
                    targetCard.style.removeProperty('border'); // Reverts to bootstrap border class
                    targetCard.style.setProperty('box-shadow', '0 2px 4px rgba(0,0,0,0.05)', 'important');
                    targetCard.style.zIndex = '1';
                    
                    if (innerHeader) {
                        innerHeader.style.backgroundColor = '';
                        innerHeader.classList.add('bg-light');
                    }
                }, 4000); // 4000ms = 4 seconds
            }
        }, 600); // Slight delay to ensure DOM is fully rendered first
    }
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
                awayStarters = localAwayPlayers.map(p => ({ athlete: { displayName: p.name, position: { abbreviation: p.pos } } }));
                awayIsProjected = false;
            } else if (awayTeamData.starters) {
                awayStarters = awayTeamData.starters; awayIsProjected = false;
            } else if (localAwayPlayers) {
                awayStarters = localAwayPlayers.map(p => ({ athlete: { displayName: p.name, position: { abbreviation: p.pos } } }));
            }

            let homeStarters = [], homeIsProjected = true;
            let localHomePlayers = (localGameMatch && localGameMatch.rosters && localGameMatch.rosters[homeStd]) ? localGameMatch.rosters[homeStd].players : null;
            if (localHomePlayers && localHomePlayers.every(p => p.verified)) {
                homeStarters = localHomePlayers.map(p => ({ athlete: { displayName: p.name, position: { abbreviation: p.pos } } }));
                homeIsProjected = false;
            } else if (homeTeamData.starters) {
                homeStarters = homeTeamData.starters; homeIsProjected = false;
            } else if (localHomePlayers) {
                homeStarters = localHomePlayers.map(p => ({ athlete: { displayName: p.name, position: { abbreviation: p.pos } } }));
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
        container.innerHTML = `<div class="col-12 text-center mt-5"><div class="alert alert-danger">Failed to load schedule.</div></div>`;
    }
}

function renderGames() {
    const container = document.getElementById('games-container');
    container.innerHTML = '';
    const searchText = document.getElementById('team-search')?.value.toLowerCase() || '';
    ALL_GAMES_DATA.filter(item => (item.away.team.displayName + " " + item.home.team.displayName).toLowerCase().includes(searchText))
        .sort((a, b) => a.gameDate - b.gameDate)
        .forEach(item => container.appendChild(createGameCard(item)));
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
        const items = players.map(p => {
            const a = p.athlete || p;
            return `<li class="px-2 py-1 border-bottom small"><span class="text-muted fw-bold me-2">${a.position?.abbreviation || '-'}</span><span class="fw-bold">${a.displayName || a.fullName}</span></li>`;
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
});
