// ==========================================
// CONFIGURATION
// ==========================================
const DEFAULT_DATE = new Date().toLocaleDateString('en-CA');
let ALL_GAMES_DATA = []; 
let LIVE_GAMES_DATA = {}; 
let ALL_SLATES = { fanduel: [], draftkings: [] };
let ARE_ALL_EXPANDED = false;
let PLAYERS_DB = {}; // Holds our player database
window.LEADERBOARD_SEARCH_TEXT = ''; // Holds the live leaderboard search state

// State managers
window.MASTER_TAB = 'lineups'; 
window.CARD_STATE = {}; 
window.RENDERED_PBP = {}; 
window.PBP_QUEUE = {};    
window.LAST_SEQ_SEEN = {}; 
window.PENDING_LIVE_DATA = {}; 
window.GAME_QUEUE_TIMERS = {}; 
let livePollInterval;

// Global CSS injection
const style = document.createElement('style');
style.innerHTML = `
    .slow-pulse { animation: spinner-grow 2s linear infinite !important; }
    @keyframes slideInHighlight {
        0% { background-color: #d1e7dd; transform: translateY(-5px); opacity: 0; }
        10% { transform: translateY(0); opacity: 1; }
        100% { background-color: transparent; }
    }
    .new-play-anim { animation: slideInHighlight 3.5s ease-out; }
    .leaderboard-tab {
        font-size: 0.7rem; font-weight: 700; color: #adb5bd; cursor: pointer;
        padding: 8px 0; text-align: center; text-transform: uppercase; letter-spacing: 0.5px;
        border-bottom: 2px solid transparent; transition: all 0.2s ease;
    }
    .leaderboard-tab.active { color: #20c997; border-bottom: 2px solid #20c997; }
    .leaderboard-tab:hover:not(.active) { color: #495057; }
    
    /* Search Bar Styling */
    #leaderboard-search::placeholder { color: #868e96; opacity: 1; }
    #leaderboard-search:focus { box-shadow: none; border-color: #20c997; outline: none; }
`;
document.head.appendChild(style);

// --- PLAYER DATABASE HELPERS ---
function normalizeName(name) {
    if (!name) return "";
    return name.toLowerCase()
               .replace(/[.,']/g, '') 
               .replace(/-/g, ' ') 
               .replace(/\s+(jr|sr|ii|iii|iv)$/g, '') 
               .replace(/\s+/g, ' ') 
               .trim();
}

function getPlayerFromDB(id, fullName) {
    if (id && PLAYERS_DB[id]) return PLAYERS_DB[id];
    
    // Fallback: Fuzzy search by normalized name
    const searchName = normalizeName(fullName);
    for (let key in PLAYERS_DB) {
        if (normalizeName(PLAYERS_DB[key].name) === searchName) {
            return PLAYERS_DB[key];
        }
    }
    return null;
}

// ==========================================
// DYNAMIC QUEUE PROCESSOR
// ==========================================
function processGameQueue(localId) {
    if (window.GAME_QUEUE_TIMERS[localId]) return;

    function runNextPlay() {
        if (!window.PBP_QUEUE[localId] || window.PBP_QUEUE[localId].length === 0) {
            window.GAME_QUEUE_TIMERS[localId] = false;
            if (window.PENDING_LIVE_DATA[localId]) {
                setTimeout(() => {
                    if (window.PENDING_LIVE_DATA[localId] && (!window.PBP_QUEUE[localId] || window.PBP_QUEUE[localId].length === 0)) {
                        LIVE_GAMES_DATA[localId] = window.PENDING_LIVE_DATA[localId];
                        delete window.PENDING_LIVE_DATA[localId];
                        if (window.MASTER_TAB === 'live') renderGames(); 
                    }
                }, 3500); 
            }
            return;
        }

        window.GAME_QUEUE_TIMERS[localId] = true;
        let playToInject = window.PBP_QUEUE[localId].shift();
        
        if (!window.RENDERED_PBP[localId]) window.RENDERED_PBP[localId] = [];
        window.RENDERED_PBP[localId].unshift(playToInject);

        if (!window.CARD_STATE[localId]) window.CARD_STATE[localId] = {};
        let state = window.CARD_STATE[localId];
        let playPeriod = Number(playToInject.period);
        let switchedQuarter = false;
        
        let isFinal = LIVE_GAMES_DATA[localId] && LIVE_GAMES_DATA[localId].status === 'post';

        if (!isFinal && (!state.highestPeriodSeen || playPeriod > state.highestPeriodSeen)) {
            if (!state.pbpTab || state.pbpTab === 'All' || state.pbpTab === (state.highestPeriodSeen || 1).toString()) {
                state.pbpTab = playPeriod.toString();
                switchedQuarter = true;
            }
            state.highestPeriodSeen = playPeriod;
        }

        if (window.MASTER_TAB === 'live') {
            if (switchedQuarter) renderGames();
            else injectPlayIntoDOM(localId, playToInject);
        }

        const randomSeconds = Math.floor(Math.random() * 5) + 1;
        setTimeout(runNextPlay, randomSeconds * 1000);
    }
    runNextPlay();
}

// ==========================================
// 1. MAIN APP LOGIC 
// ==========================================
function getStandardAbbr(abbr) {
    if (!abbr) return "";
    let cleanAbbr = abbr.replace(/[^A-Za-z]/g, '').toUpperCase();
    const map = { "NY": "NYK", "NO": "NOP", "SA": "SAS", "GS": "GSW", "WSH": "WAS", "UTAH": "UTA" };
    return map[cleanAbbr] || cleanAbbr;
}

async function fetchLocalProbables(dateToFetch) {
    try {
        const response = await fetch(`data/${dateToFetch}.json?v=` + new Date().getTime());
        if (response.ok) return await response.json();
    } catch (e) {
        console.log(`No daily JSON found for ${dateToFetch}.`);
    }
    return { games: [], slates: { fanduel: [], draftkings: [] }, espn_schedule: null };
}

async function pollLiveData(dateToFetch) {
    try {
        const liveResponse = await fetch(`data/LIVE/live_${dateToFetch}.json?v=` + new Date().getTime(), { cache: 'no-store' });
        let needsGlobalRender = false;
        
        if (liveResponse.ok) {
            const incomingData = await liveResponse.json();
            
            for (let localId in incomingData) {
                let game = incomingData[localId];
                let hasNewPlays = false;

                if (game.play_by_play) {
                    let fullLog = game.play_by_play.full_log || [];
                    
                    if (!window.LAST_SEQ_SEEN[localId]) {
                        window.RENDERED_PBP[localId] = [...fullLog];
                        window.LAST_SEQ_SEEN[localId] = game.play_by_play.last_seq || 0;
                        if (!window.CARD_STATE[localId]) window.CARD_STATE[localId] = {};
                        let state = window.CARD_STATE[localId];
                        if (fullLog.length > 0) state.highestPeriodSeen = Math.max(...fullLog.map(p => Number(p.period)));

                        if (game.status === 'post') {
                            state.hasFlippedPbp = true;
                            state.pbpTab = 'All';
                            state.finalTimerStarted = true;
                        }
                    } else {
                        let unseenPlays = fullLog.filter(p => p.seq > window.LAST_SEQ_SEEN[localId]);
                        if (unseenPlays.length > 0) {
                            hasNewPlays = true;
                            if (!window.PBP_QUEUE[localId]) window.PBP_QUEUE[localId] = [];
                            window.PBP_QUEUE[localId].push(...[...unseenPlays].reverse());
                            window.LAST_SEQ_SEEN[localId] = Math.max(...unseenPlays.map(p => p.seq));
                            processGameQueue(localId);
                        }
                    }
                }

                if (hasNewPlays || (window.PBP_QUEUE[localId] && window.PBP_QUEUE[localId].length > 0)) {
                    window.PENDING_LIVE_DATA[localId] = game;
                } else {
                    let isAlreadyPost = LIVE_GAMES_DATA[localId] && LIVE_GAMES_DATA[localId].status === 'post';
                    LIVE_GAMES_DATA[localId] = game;
                    if (!isAlreadyPost || game.status !== 'post') needsGlobalRender = true;
                }

                if (game.status === 'post') {
                    if (!window.CARD_STATE[localId]) window.CARD_STATE[localId] = {};
                    let state = window.CARD_STATE[localId];
                    if (!state.hasFlippedPbp && !state.finalTimerStarted) {
                        state.finalTimerStarted = true;
                        setTimeout(() => {
                            let currentState = window.CARD_STATE[localId];
                            if (currentState && !currentState.hasFlippedPbp) {
                                currentState.hasFlippedPbp = true;
                                currentState.pbpTab = 'All';
                                if (window.MASTER_TAB === 'live') {
                                    renderGames();
                                    setTimeout(() => {
                                        const listContainer = document.getElementById(`pbp-list-${localId}`);
                                        if (listContainer) listContainer.scrollTop = 0;
                                    }, 100);
                                }
                            }
                        }, 300000); 
                    }
                }
            }
        }

        const dailyData = await fetchLocalProbables(dateToFetch);
        if (dailyData && dailyData.games) {
            ALL_GAMES_DATA.forEach(gameObj => {
                const awayStd = getStandardAbbr(gameObj.away.team.abbreviation);
                const homeStd = getStandardAbbr(gameObj.home.team.abbreviation);
                const localGameMatch = dailyData.games.find(g => g.id === gameObj.localId);
                
                if (localGameMatch && localGameMatch.rosters) {
                    if (localGameMatch.rosters[awayStd] && localGameMatch.rosters[awayStd].players) {
                        const isVerified = localGameMatch.rosters[awayStd].players.every(p => p.verified === true);
                        if (gameObj.awayIsProjected !== !isVerified) {
                            gameObj.awayIsProjected = !isVerified;
                            needsGlobalRender = true;
                        }
                        gameObj.awayStarters = localGameMatch.rosters[awayStd].players.map(p => ({ athlete: { id: p.id || p.espn_id, displayName: p.name, position: { abbreviation: p.pos }, dfs: p } }));
                    }
                    if (localGameMatch.rosters[homeStd] && localGameMatch.rosters[homeStd].players) {
                        const isVerified = localGameMatch.rosters[homeStd].players.every(p => p.verified === true);
                        if (gameObj.homeIsProjected !== !isVerified) {
                            gameObj.homeIsProjected = !isVerified;
                            needsGlobalRender = true;
                        }
                        gameObj.homeStarters = localGameMatch.rosters[homeStd].players.map(p => ({ athlete: { id: p.id || p.espn_id, displayName: p.name, position: { abbreviation: p.pos }, dfs: p } }));
                    }
                }
            });
        }

        if (needsGlobalRender) renderGames(); 
    } catch (e) { 
        console.error("Polling error:", e);
    }
}

// ==========================================
// 2. TOGGLE LOGIC & STATE MANAGEMENT
// ==========================================
window.toggleBenchState = function(localId, viewType) {
    if (!window.CARD_STATE[localId]) window.CARD_STATE[localId] = {};
    const key = viewType + 'BenchOpen';
    window.CARD_STATE[localId][key] = !window.CARD_STATE[localId][key];
    renderGames();
};

window.switchPbpTab = function(localId, tab) {
    if (!window.CARD_STATE[localId]) window.CARD_STATE[localId] = {};
    window.CARD_STATE[localId].pbpTab = tab;
    renderGames(); 
};

window.togglePbpState = function(localId) {
    if (!window.CARD_STATE[localId]) window.CARD_STATE[localId] = {};
    window.CARD_STATE[localId].pbpOpen = !window.CARD_STATE[localId].pbpOpen;
    renderGames();
};

function setupMasterTabs() {
    const slateSelector = document.getElementById('slate-selector');
    if (!slateSelector || document.getElementById('master-tab-container')) return;

    const tabContainer = document.createElement('div');
    tabContainer.id = 'master-tab-container';
    tabContainer.className = 'd-inline-block ms-3 align-middle';
    tabContainer.innerHTML = `
        <div class="btn-group" role="group">
            <input type="radio" class="btn-check" name="masterTab" id="tab-lineups" value="lineups" checked>
            <label class="btn btn-outline-dark btn-sm fw-bold shadow-sm" for="tab-lineups">Lineups 📋</label>
            <input type="radio" class="btn-check" name="masterTab" id="tab-live" value="live">
            <label class="btn btn-outline-success btn-sm fw-bold shadow-sm position-relative" for="tab-live">
                Live Games 🟢
                <span class="position-absolute badge rounded-pill bg-warning text-dark border border-light" 
                      style="font-size: 0.45rem; top: -6px; right: -12px; padding: 2px 5px; z-index: 10; letter-spacing: 0.5px;">
                    BETA
                </span>
            </label>
        </div>`;
    slateSelector.parentNode.insertBefore(tabContainer, slateSelector.nextSibling);

    document.querySelectorAll('input[name="masterTab"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            window.MASTER_TAB = e.target.value;
            renderGames(); 
        });
    });
}

function hasSlatePlayers(game, platform, slateId) {
    if (slateId === 'all') return true; 
    const checkRoster = (players) => {
        if (!players) return false;
        return players.some(p => {
            const a = p.athlete || p;
            if (!a.dfs) return false;
            const slatesDict = platform === 'dk' ? (a.dfs.dk_slates || {}) : (a.dfs.fd_slates || {});
            return !!slatesDict[slateId];
        });
    };
    return checkRoster(game.awayStarters) || checkRoster(game.homeStarters) || checkRoster(game.awayBench) || checkRoster(game.homeBench);
}

function hasAnyDfsSalaries(game, platform) {
    const checkRoster = (players) => {
        if (!players) return false;
        return players.some(p => {
            const a = p.athlete || p;
            if (!a.dfs) return false;
            return (platform === 'dk' ? (a.dfs.dk_salary || 0) : (a.dfs.salary || 0)) > 0;
        });
    };
    return checkRoster(game.awayStarters) || checkRoster(game.homeStarters) || checkRoster(game.awayBench) || checkRoster(game.homeBench);
}

// ==========================================
// 3. UI RENDERING & BUILDERS
// ==========================================
function populateSlates() {
    const platformNode = document.querySelector('input[name="dfsPlatform"]:checked');
    const platform = platformNode ? platformNode.value : 'fd';
    const platKey = platform === 'dk' ? 'draftkings' : 'fanduel';
    
    const selector = document.getElementById('slate-selector');
    if (!selector) return;
    
    const currentVal = selector.value;
    selector.innerHTML = '<option value="all">All Slates</option>';
    
    const datePicker = document.getElementById('date-picker');
    const dateToFetch = datePicker ? datePicker.value : DEFAULT_DATE;
    
    let dateObj = new Date();
    if (dateToFetch && dateToFetch.includes('-')) {
        const [y, m, d] = dateToFetch.split('-');
        dateObj = new Date(y, m - 1, d);
    }
    
    const dayOfWeek = dateObj.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();

    if (ALL_SLATES[platKey] && Array.isArray(ALL_SLATES[platKey])) {
        ALL_SLATES[platKey].forEach(slate => {
            const upperName = slate.name.toUpperCase();
            const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
            const containsADay = days.some(day => upperName.includes(day));
            
            if (upperName.includes(dayOfWeek) || !containsADay) {
                const opt = document.createElement('option');
                opt.value = slate.id;
                opt.textContent = slate.name;
                selector.appendChild(opt);
            }
        });
    }
    
    if(Array.from(selector.options).some(opt => opt.value === currentVal)) selector.value = currentVal;
    else selector.value = 'all';

    setupMasterTabs();
}

async function init(dateToFetch) {
    if (window.updateSEO) window.updateSEO(dateToFetch);
    const container = document.getElementById('games-container');
    const datePicker = document.getElementById('date-picker');
    ALL_GAMES_DATA = [];
    LIVE_GAMES_DATA = {};
    if (datePicker) datePicker.value = dateToFetch;

    if (container) {
        container.innerHTML = `
            <div class="col-12 text-center mt-5 pt-5">
                <div class="spinner-border text-success" role="status"></div>
                <p class="mt-3 text-muted fw-bold">Loading Court Data...</p>
            </div>`;
    }
    
    let espnDateStr = dateToFetch.replace(/-/g, '');
    const dObj = new Date(dateToFetch);
    if (!isNaN(dObj)) {
        espnDateStr = dObj.getFullYear() + String(dObj.getMonth() + 1).padStart(2, '0') + String(dObj.getDate()).padStart(2, '0');
    }
    const ESPN_API_URL = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${espnDateStr}`;
    
    try {
        try {
            const playersRes = await fetch('data/players.json?v=' + new Date().getTime());
            if (playersRes.ok) PLAYERS_DB = await playersRes.json();
        } catch(e) {
            console.log("No players.json found, falling back to basic data.");
        }

        const localData = await fetchLocalProbables(dateToFetch);
        let scheduleData;
        
        if (localData.espn_schedule && localData.espn_schedule.events) {
            scheduleData = localData.espn_schedule;
        } else {
            const scheduleResponse = await fetch(ESPN_API_URL);
            scheduleData = await scheduleResponse.json();
        }

        const localProbables = localData.games || [];
        ALL_SLATES = localData.slates || { fanduel: [], draftkings: [] };
        
        populateSlates();

        if (!scheduleData.events || scheduleData.events.length === 0) {
            container.innerHTML = `<div class="col-12 text-center mt-5"><div class="alert alert-light border shadow-sm py-4"><h5 class="text-muted mb-0">No games scheduled for ${dateToFetch}</h5></div></div>`;
            return;
        }

        scheduleData.events.forEach(game => {
            const comp = game.competitions[0];
            const homeTeamData = comp.competitors.find(c => c.homeAway === 'home');
            const awayTeamData = comp.competitors.find(c => c.homeAway === 'away');
            if(!homeTeamData || !awayTeamData) return;

            const homeStd = getStandardAbbr(homeTeamData.team.abbreviation);
            const awayStd = getStandardAbbr(awayTeamData.team.abbreviation);
            const espnGameDate = new Date(game.date).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

            const localGameMatch = localProbables.find(g => {
                if (!g.teams || g.teams.length < 2) return false;
                const t1 = getStandardAbbr(g.teams[0]);
                const t2 = getStandardAbbr(g.teams[1]);
                return (t1 === homeStd || t1 === awayStd) && (t2 === homeStd || t2 === awayStd) && (g.date ? g.date === espnGameDate : true);
            });

            const localId = localGameMatch ? localGameMatch.id : `${awayStd}-${homeStd}-${espnGameDate}`;

            let odds = { spread: "TBD", overUnder: "TBD" };
            if (comp.odds && comp.odds.length > 0) {
                odds.spread = comp.odds[0].details || "TBD";
                odds.overUnder = comp.odds[0].overUnder ? `O/U ${comp.odds[0].overUnder}` : "O/U TBD";
            } else if (localGameMatch && localGameMatch.meta) {
                if (localGameMatch.meta.spread && localGameMatch.meta.spread !== "TBD") odds.spread = localGameMatch.meta.spread;
                if (localGameMatch.meta.total && localGameMatch.meta.total !== "TBD") odds.overUnder = `O/U ${localGameMatch.meta.total}`;
            }

            const extractRoster = (teamData, abbr) => {
                let starters = [], isProj = true, bench = [];
                let localPlayers = (localGameMatch && localGameMatch.rosters && localGameMatch.rosters[abbr]) ? localGameMatch.rosters[abbr].players : null;
                let localBench = (localGameMatch && localGameMatch.rosters && localGameMatch.rosters[abbr]) ? localGameMatch.rosters[abbr].bench : [];
                
                const mapPlayer = p => ({ athlete: { id: p.id || p.espn_id, displayName: p.name, position: { abbreviation: p.pos }, dfs: p } });

                if (localPlayers && localPlayers.every(p => p.verified)) {
                    starters = localPlayers.map(mapPlayer);
                    isProj = false;
                } else if (teamData.starters) {
                    starters = teamData.starters; isProj = false;
                } else if (localPlayers) {
                    starters = localPlayers.map(mapPlayer);
                }
                if (localBench) bench = localBench.map(mapPlayer);
                return { starters, bench, isProj };
            };

            const awayRoster = extractRoster(awayTeamData, awayStd);
            const homeRoster = extractRoster(homeTeamData, homeStd);

            ALL_GAMES_DATA.push({
                gameRaw: game, home: homeTeamData, away: awayTeamData,
                homeStarters: homeRoster.starters, awayStarters: awayRoster.starters,
                homeIsProjected: homeRoster.isProj, awayIsProjected: awayRoster.isProj,
                homeBench: homeRoster.bench, awayBench: awayRoster.bench,
                odds, venue: comp.venue?.fullName || "TBD",
                gameDate: new Date(game.date), status: game.status?.type?.detail || 'Scheduled',
                localId: localId
            });
        });

        renderGames();
        await pollLiveData(dateToFetch);
        clearInterval(livePollInterval);
        livePollInterval = setInterval(() => pollLiveData(dateToFetch), 30000);

    } catch (error) {
        console.error("Init error:", error);
        if (container) container.innerHTML = `<div class="col-12 text-center mt-5"><div class="alert alert-danger shadow-sm border py-4 fw-bold">Failed to load schedule.</div></div>`;
    }
}

// ==========================================
// LEADERBOARD BUILDERS
// ==========================================
function shortenPlayerName(fullName) {
    if (!fullName) return "Unknown";
    const parts = fullName.split(' ');
    if (parts.length === 1) return fullName;
    const initial = parts[0].charAt(0).toUpperCase() + '.';
    const lastName = parts.slice(1).join(' ');
    return `${initial} ${lastName}`;
}

window.openPlayerModal = function(el) {
    console.log("Player clicked", JSON.parse(decodeURIComponent(el.getAttribute('data-player'))));
};

function buildTopPlaysCard(filteredGames, platform, selectedSlate) {
    let allPlayers = [];
    filteredGames.forEach(game => {
        const extract = (roster, teamAbbr, teamLogo) => {
            if (!roster) return;
            roster.forEach(p => {
                const a = p.athlete || p;
                if (!a.dfs) return;
                
                let sal = 0, proj = 0, val = 0;
                const slatesDict = platform === 'dk' ? (a.dfs.dk_slates || {}) : (a.dfs.fd_slates || {});
                
                if (selectedSlate !== 'all' && slatesDict[selectedSlate]) {
                    sal = slatesDict[selectedSlate].salary;
                    proj = slatesDict[selectedSlate].proj;
                    val = slatesDict[selectedSlate].value;
                } else if (selectedSlate === 'all') {
                    sal = platform === 'dk' ? a.dfs.dk_salary : a.dfs.salary;
                    proj = platform === 'dk' ? a.dfs.dk_proj : a.dfs.proj;
                    val = platform === 'dk' ? a.dfs.dk_value : a.dfs.value;
                }
                
                if (sal > 0 || proj > 0) {
                    let name = a.displayName || a.fullName || 'Unknown';
                    
                    let dbPlayer = getPlayerFromDB(a.id, name);
                    let photo = dbPlayer ? dbPlayer.photo : (a.headshot?.href || a.dfs?.photo || '');
                    
                    let pos = (a.dfs && a.dfs.pos) ? a.dfs.pos : (a.position?.abbreviation || 'Flex');
                    if (platform === 'dk' && a.dfs && a.dfs.dk_pos) pos = a.dfs.dk_pos;
                    
                    allPlayers.push({ id: a.id || name, name, pos, teamAbbrev: teamAbbr, teamLogo, photo, salary: sal, proj, value: val });
                }
            });
        };
        extract(game.awayStarters, getStandardAbbr(game.away.team.abbreviation), game.away.team.logo);
        extract(game.awayBench, getStandardAbbr(game.away.team.abbreviation), game.away.team.logo);
        extract(game.homeStarters, getStandardAbbr(game.home.team.abbreviation), game.home.team.logo);
        extract(game.homeBench, getStandardAbbr(game.home.team.abbreviation), game.home.team.logo);
    });

    if (allPlayers.length === 0) return '';
    allPlayers = Array.from(new Map(allPlayers.map(p => [p.id, p])).values());

    const topValue = [...allPlayers].sort((a, b) => (b.value || 0) - (a.value || 0)).slice(0, 20);
    const topProj = [...allPlayers].sort((a, b) => parseFloat(b.proj || 0) - parseFloat(a.proj || 0)).slice(0, 20);

    const buildList = (players, isValue) => {
        return players.map((p, index) => {
            const photoHtml = (p.photo && p.photo.includes("http")) 
                ? `<img src="${p.photo}" style="width: 48px; height: 48px; border-radius: 50%; object-fit: cover; border: 1px solid #dee2e6; background: #fff;">`
                : `<div style="width: 48px; height: 48px; border-radius: 50%; background-color: #f8f9fa; color: #495057; display: flex; align-items: center; justify-content: center; font-size: 1.1rem; font-weight: 800; border: 1px solid #dee2e6;">${p.name.charAt(0)}</div>`;
            
            const teamBadge = p.teamLogo ? `<img src="${p.teamLogo}" style="width: 20px; height: 20px; position: absolute; bottom: -2px; right: -4px; border-radius: 50%; background: #fff; border: 1px solid #dee2e6; object-fit: contain; padding: 1px;">` : '';
            const highlightMetric = isValue ? `<span class="text-success">${parseFloat(p.value || 0).toFixed(2)}x</span>` : `<span class="text-primary">${p.proj || 0}</span> <span class="text-muted" style="font-size:0.6rem;">pts</span>`;
            
            return `
            <div class="d-flex align-items-center justify-content-between py-2 border-bottom user-select-none" style="cursor: pointer; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='#f8f9fa'" onmouseout="this.style.backgroundColor='transparent'" onclick="openPlayerModal(this)" data-player="${encodeURIComponent(JSON.stringify(p))}">
                <div class="d-flex align-items-center overflow-hidden">
                    <div class="fw-bold text-muted me-2 text-end" style="font-size: 0.85rem; width: 22px;">${index + 1}.</div>
                    <div class="me-3 position-relative flex-shrink-0">
                        ${photoHtml}
                        ${teamBadge}
                    </div>
                    <div class="d-flex flex-column justify-content-center overflow-hidden pe-1">
                        <span class="fw-bold text-dark text-truncate" style="font-size: 0.95rem; max-width: 220px;" title="${p.name}">${shortenPlayerName(p.name)}</span>
                        <span class="text-muted text-truncate" style="font-size: 0.72rem; max-width: 240px;">
                            ${p.pos} • ${p.teamAbbrev} • $${p.salary} • ${p.proj} pts
                        </span>
                    </div>
                </div>
                <div class="text-end ms-1 flex-shrink-0">
                    <div class="fw-bold" style="font-size: 1.2rem;">${highlightMetric}</div>
                </div>
            </div>`;
        }).join('');
    };

    return `
    <div class="col-12 col-md-6 col-lg-4 px-1 mb-3">
        <div class="card shadow-sm border overflow-hidden" style="background-color: #fff; border-radius: 12px; border-color: #dee2e6 !important;">
            <div class="card-header bg-dark text-white py-2 d-flex justify-content-between align-items-center">
                <h6 class="mb-0 fw-bold" style="font-size: 0.85rem;">⭐ Slate Top Plays</h6>
                <span class="badge bg-secondary" style="font-size: 0.6rem;">${platform === 'dk' ? 'DraftKings' : 'FanDuel'}</span>
            </div>
            <div class="bg-light border-bottom d-flex justify-content-center align-items-center px-2 py-0">
                <div class="d-flex w-100">
                    <div class="leaderboard-tab active w-50" id="tab-top-value" onclick="document.getElementById('view-top-value').classList.remove('d-none'); document.getElementById('view-top-proj').classList.add('d-none'); this.classList.add('active'); document.getElementById('tab-top-proj').classList.remove('active');">TOP VALUE</div>
                    <div class="leaderboard-tab w-50" id="tab-top-proj" onclick="document.getElementById('view-top-proj').classList.remove('d-none'); document.getElementById('view-top-value').classList.add('d-none'); this.classList.add('active'); document.getElementById('tab-top-value').classList.remove('active');">TOP PROJECTIONS</div>
                </div>
            </div>
            <div class="card-body p-0">
                <div id="view-top-value" class="px-2" style="max-height: 245px; overflow-y: auto;">${buildList(topValue, true)}</div>
                <div id="view-top-proj" class="px-2 d-none" style="max-height: 245px; overflow-y: auto;">${buildList(topProj, false)}</div>
            </div>
        </div>
    </div>`;
}

function buildLiveLeaderboardCard(filteredGames, platform) {
    let livePlayers = [];
    const fpKey = platform === 'dk' ? 'dk_pts' : 'fd_pts';
    
    filteredGames.forEach(game => {
        const liveMatch = LIVE_GAMES_DATA[game.localId];
        if (!liveMatch || !liveMatch.players) return;

        let currentPeriod = 0;
        if (liveMatch.play_by_play && liveMatch.play_by_play.full_log && liveMatch.play_by_play.full_log.length > 0) {
            currentPeriod = liveMatch.play_by_play.full_log[0].period;
        } else if (game.gameRaw && game.gameRaw.status) {
            currentPeriod = game.gameRaw.status.period;
        }

        let periodText = "";
        let timeText = liveMatch.clock || "";
        
        if (liveMatch.status === 'post' || timeText.toLowerCase().includes('final')) {
            periodText = "FINAL";
            timeText = "";
        } else if (timeText.toLowerCase().includes('half')) {
            periodText = "HT";
            timeText = "";
        } else if (currentPeriod > 0) {
            if (currentPeriod <= 4) periodText = currentPeriod + "Q";
            else periodText = "OT" + (currentPeriod - 4);
        } else {
            periodText = "PRE";
        }
        
        timeText = timeText.split(' - ')[0].trim();
        if (timeText.toLowerCase().includes('end')) timeText = "0:00";
        
        const extractLive = (teamAbbr, teamLogo, roster) => {
            const liveTeamData = liveMatch.players[teamAbbr];
            if (!liveTeamData) return;
            
            for (const [playerName, stats] of Object.entries(liveTeamData)) {
                let fp = stats[fpKey] || 0;
                if (fp > 0) {
                    let photo = '', pos = '-';
                    
                    let matchedPlayer = (roster || []).find(p => {
                        const a = p.athlete || p;
                        return normalizeName(a.displayName || a.fullName) === normalizeName(playerName);
                    });
                    
                    let espnId = stats.athlete?.id || stats.id;
                    if (matchedPlayer) {
                        const a = matchedPlayer.athlete || matchedPlayer;
                        if (!espnId && a.id) espnId = a.id;
                        let dbPlayer = getPlayerFromDB(espnId, playerName);
                        if (dbPlayer) {
                            photo = dbPlayer.photo;
                            pos = dbPlayer.pos;
                        } else {
                            photo = a.headshot?.href || a.dfs?.photo || '';
                        }
                        if (pos === '-' || !pos) {
                            pos = (a.dfs && a.dfs.pos) ? a.dfs.pos : (a.position?.abbreviation || 'Flex');
                            if (platform === 'dk' && a.dfs && a.dfs.dk_pos) pos = a.dfs.dk_pos;
                        }
                    } else {
                        let dbPlayer = getPlayerFromDB(espnId, playerName);
                        if (dbPlayer) {
                            photo = dbPlayer.photo;
                            pos = dbPlayer.pos;
                        }
                    }

                    // --- NEW: LOGIC TO DETECT IF PLAYER IS ON COURT ---
                    // Only pulse if they are on court AND the game isn't over
                    const isOnCourt = stats.is_on_court === true && liveMatch.status !== 'post';

                    livePlayers.push({ 
                        name: playerName, 
                        teamAbbrev: teamAbbr, 
                        teamLogo, 
                        photo, 
                        pos, 
                        live_fp: fp, 
                        live_stats: stats, 
                        periodText: periodText, 
                        timeText: timeText,
                        isOnCourt: isOnCourt 
                    });
                }
            }
        };
        
        extractLive(getStandardAbbr(game.away.team.abbreviation), game.away.team.logo, [...(game.awayStarters||[]), ...(game.awayBench||[])]);
        extractLive(getStandardAbbr(game.home.team.abbreviation), game.home.team.logo, [...(game.homeStarters||[]), ...(game.homeBench||[])]);
    });

    if (livePlayers.length === 0) return '';
    
    if (window.LEADERBOARD_SEARCH_TEXT) {
        const term = window.LEADERBOARD_SEARCH_TEXT.toLowerCase();
        livePlayers = livePlayers.filter(p => 
            p.name.toLowerCase().includes(term) || 
            p.teamAbbrev.toLowerCase().includes(term)
        );
    }
    
    livePlayers.sort((a, b) => b.live_fp - a.live_fp);

    const listHtml = livePlayers.map((p, index) => {
        const photoHtml = (p.photo && p.photo.includes("http")) 
            ? `<img src="${p.photo}" style="width: 48px; height: 48px; border-radius: 50%; object-fit: cover; border: 1px solid #dee2e6; background: #fff;">`
            : `<div style="width: 48px; height: 48px; border-radius: 50%; background-color: #f8f9fa; color: #495057; display: flex; align-items: center; justify-content: center; font-size: 1.1rem; font-weight: 800; border: 1px solid #dee2e6;">${p.name.charAt(0)}</div>`;
        
        const teamBadge = p.teamLogo ? `<img src="${p.teamLogo}" style="width: 20px; height: 20px; position: absolute; bottom: -2px; right: -4px; border-radius: 50%; background: #fff; border: 1px solid #dee2e6; object-fit: contain; padding: 1px;">` : '';
        
        const stats = p.live_stats;
        
        let clockBadgeHtml = '';
        if (p.periodText === 'FINAL' || p.periodText === 'HT' || p.periodText === 'PRE') {
            clockBadgeHtml = `<div class="badge bg-secondary text-white shadow-sm d-flex align-items-center justify-content-center" style="font-size: 0.55rem; padding: 0; width: 36px; height: 36px;">${p.periodText}</div>`;
        } else {
            clockBadgeHtml = `
                <div class="badge bg-white text-dark border border-dark shadow-sm d-flex flex-column align-items-center justify-content-center" style="width: 36px; height: 36px; padding: 0;">
                    <span style="font-size: 0.65rem; line-height: 1.1;">${p.periodText}</span>
                    <span style="font-size: 0.55rem; line-height: 1; font-weight: normal;">${p.timeText}</span>
                </div>`;
        }

        const timeDisplayHtml = `
            <div class="me-2 flex-shrink-0 d-flex justify-content-center" style="width: 36px;">
                ${clockBadgeHtml}
            </div>
        `;
        
        const subLine = `${p.pos} • ${p.teamAbbrev} <span class="fw-bold text-dark ms-1 border-start ps-1 border-secondary border-opacity-50">${stats.PTS}p ${stats.REB}r ${stats.AST}a ${stats.STL}s ${stats.BLK}b ${stats.TO}to</span>`;

        // --- NEW: ON-COURT FLASHING DOT ---
        const onCourtDot = p.isOnCourt 
            ? `<span class="spinner-grow spinner-grow-sm text-success slow-pulse me-1" style="width: 0.5rem; height: 0.5rem;" role="status"></span>` 
            : '';

        return `
        <div class="d-flex align-items-center justify-content-between py-2 border-bottom user-select-none" style="cursor: pointer; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='#f8f9fa'" onmouseout="this.style.backgroundColor='transparent'" onclick="openPlayerModal(this)" data-player="${encodeURIComponent(JSON.stringify(p))}">
            <div class="d-flex align-items-center overflow-hidden">
                ${timeDisplayHtml}
                <div class="me-2 position-relative flex-shrink-0">
                    ${photoHtml}
                    ${teamBadge}
                </div>
                <div class="d-flex flex-column justify-content-center overflow-hidden pe-1">
                    <div class="d-flex align-items-center">
                        ${onCourtDot}
                        <span class="fw-bold text-dark text-truncate" style="font-size: 0.95rem; max-width: 170px;" title="${p.name}">${shortenPlayerName(p.name)}</span>
                    </div>
                    <span class="text-muted text-truncate" style="font-size: 0.72rem; max-width: 250px;">${subLine}</span>
                </div>
            </div>
            <div class="text-end ms-1 flex-shrink-0">
                <div class="fw-bold text-success" style="font-size: 1.2rem;">
                    ${p.live_fp.toFixed(1)}
                </div>
            </div>
        </div>`;
    }).join('');

    return `
    <div class="col-12 col-md-6 col-lg-4 px-1 mb-3" id="live-leaderboard-container">
        <div class="card shadow-sm border overflow-hidden" style="background-color: #fff; border-radius: 12px; border-color: #dee2e6 !important;">
            <div class="card-header bg-dark text-white py-2 d-flex justify-content-between align-items-center">
                <h6 class="mb-0 fw-bold text-nowrap" style="font-size: 0.85rem;">🔥 Live Leaders</h6>
                
                <div class="position-relative mx-2 w-100" style="max-width: 140px;">
                    <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" fill="#adb5bd" viewBox="0 0 16 16" style="position: absolute; left: 10px; top: 50%; transform: translateY(-50%); pointer-events: none;">
                        <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z"/>
                    </svg>
                    <input type="text" id="leaderboard-search" class="form-control form-control-sm pe-2" 
                           style="background-color: #212529; color: #fff; border-color: #495057; font-size: 0.75rem; border-radius: 15px; padding-left: 26px;" 
                           placeholder="Search..." 
                           value="${window.LEADERBOARD_SEARCH_TEXT}" 
                           oninput="window.LEADERBOARD_SEARCH_TEXT = this.value; renderGames();">
                </div>
                       
                <span class="badge bg-secondary text-nowrap" style="font-size: 0.6rem;">${platform === 'dk' ? 'DraftKings' : 'FanDuel'}</span>
            </div>
            <div class="card-body p-0 px-3" id="live-leaderboard-scroll" style="max-height: 520px; overflow-y: auto;">
                ${listHtml}
            </div>
        </div>
    </div>`;
}

function renderGames() {
    const container = document.getElementById('games-container');
    if (!container) return;
    
    const platformNode = document.querySelector('input[name="dfsPlatform"]:checked');
    const platform = platformNode ? platformNode.value : 'fd';
    const selectedSlate = document.getElementById('slate-selector')?.value || 'all';

    // SCROLL AND FOCUS LOCK
    const scrollPositions = {};
    document.querySelectorAll('.live-table-wrapper, [id^="pbp-list-"], #view-top-value, #view-top-proj, #live-leaderboard-scroll').forEach(el => {
        scrollPositions[el.id] = { left: el.scrollLeft, top: el.scrollTop };
    });

    const activeElement = document.activeElement;
    const activeId = activeElement ? activeElement.id : null;
    let cursorStart = null, cursorEnd = null;
    if (activeId && (activeId === 'leaderboard-search' || activeId === 'team-search')) {
        try {
            cursorStart = activeElement.selectionStart;
            cursorEnd = activeElement.selectionEnd;
        } catch(e) {}
    }

    container.innerHTML = '';
    const searchText = document.getElementById('team-search')?.value.toLowerCase() || '';
    
    let filteredData = ALL_GAMES_DATA.filter(item => 
        (item.away.team.displayName + " " + item.home.team.displayName).toLowerCase().includes(searchText)
    );

    if (selectedSlate !== 'all') {
        filteredData = filteredData.filter(item => hasSlatePlayers(item, platform, selectedSlate));
    }

    if (window.MASTER_TAB === 'live') {
        filteredData = filteredData.filter(item => {
            const liveMatch = LIVE_GAMES_DATA[item.localId];
            return liveMatch && (liveMatch.status === 'in' || liveMatch.status === 'post');
        });
    }

    if (filteredData.length === 0) {
        const datePicker = document.getElementById('date-picker');
        const dateToFetch = datePicker ? datePicker.value : DEFAULT_DATE;
        let titleMsg = window.MASTER_TAB === 'live' ? `Live NBA Dashboard` : `NBA Lineups Hub`;
        let bodyMsg = window.MASTER_TAB === 'live' 
            ? `No games are currently live or completed for this slate.` 
            : `The fixture list is currently clear for <strong>${dateToFetch}</strong> on this slate. When clubs are in action, this dashboard automatically updates in real-time.`;

        container.innerHTML = `
            <div class="col-12 col-md-8 mx-auto mt-4 mb-5">
                <div class="card shadow-sm border text-start py-4 px-4" style="background-color: #fff; border-radius: 12px; border-color: #dee2e6 !important;">
                    <div class="d-flex align-items-center border-bottom pb-3 mb-3">
                        <div style="font-size: 2.5rem; margin-right: 15px;">🏀</div>
                        <h2 class="h4 fw-bold text-dark mb-0">${titleMsg}</h2>
                    </div>
                    <p class="text-dark mb-4" style="font-size: 0.95rem; line-height: 1.5;">${bodyMsg}</p>
                    <h3 class="h6 fw-bold text-dark mb-3">What to expect on game day:</h3>
                    <div class="row text-muted mb-3" style="font-size: 0.9rem;">
                        <div class="col-sm-6 mb-3">📋 <strong>Confirmed Starting 5:</strong> Lineups updated right before tip-off.</div>
                        <div class="col-sm-6 mb-3">⚡ <strong>Live Match Events:</strong> Real-time tracking of play-by-play.</div>
                        <div class="col-sm-6 mb-3">📊 <strong>Live Team Stats:</strong> Box scores and fantasy performance.</div>
                        <div class="col-sm-6 mb-3">📈 <strong>Live Odds:</strong> Up-to-the-minute moneyline and totals.</div>
                    </div>
                </div>
            </div>`;
        return;
    }

    if (!searchText) {
        if (window.MASTER_TAB === 'lineups') {
            const topPlaysHtml = buildTopPlaysCard(filteredData, platform, selectedSlate);
            if (topPlaysHtml) container.insertAdjacentHTML('beforeend', topPlaysHtml);
        } else if (window.MASTER_TAB === 'live') {
            const liveLeaderboardHtml = buildLiveLeaderboardCard(filteredData, platform);
            if (liveLeaderboardHtml) container.insertAdjacentHTML('beforeend', liveLeaderboardHtml);
        }
    }

    filteredData.sort((a, b) => {
        if (window.MASTER_TAB === 'live') {
            const statusA = LIVE_GAMES_DATA[a.localId] ? LIVE_GAMES_DATA[a.localId].status : 'pre';
            const statusB = LIVE_GAMES_DATA[b.localId] ? LIVE_GAMES_DATA[b.localId].status : 'pre';
            if (statusA === 'post' && statusB !== 'post') return 1;
            if (statusB === 'post' && statusA !== 'post') return -1;
            return a.gameDate - b.gameDate;
        } else {
            return a.gameDate - b.gameDate;
        }
    }).forEach((item) => {
        const card = window.MASTER_TAB === 'lineups' ? createLineupCard(item) : createLiveCard(item);
        if (card) container.appendChild(card);
    });

    // RESTORE SCROLL AND FOCUS
    document.querySelectorAll('.live-table-wrapper, [id^="pbp-list-"], #view-top-value, #view-top-proj, #live-leaderboard-scroll').forEach(el => {
        if (scrollPositions[el.id]) {
            el.scrollLeft = scrollPositions[el.id].left;
            el.scrollTop = scrollPositions[el.id].top;
        }
    });

    if (activeId) {
        const elToFocus = document.getElementById(activeId);
        if (elToFocus) {
            elToFocus.focus();
            if (cursorStart !== null && cursorEnd !== null) {
                try { elToFocus.setSelectionRange(cursorStart, cursorEnd); } catch(e) {}
            }
        }
    }
}

function injectPlayIntoDOM(localId, play) {
    const listContainer = document.getElementById(`pbp-list-${localId}`);
    if (!listContainer) return; 

    const state = window.CARD_STATE[localId] || {};
    const activeTab = state.pbpTab || 'All';

    if (activeTab === 'All' || activeTab === play.period.toString()) {
        const el = document.createElement('div');
        el.className = `d-flex align-items-start px-2 py-1 new-play-anim`;
        el.style.fontSize = '0.65rem';
        el.style.borderBottom = '1px solid #f1f3f5';
        
        const isMake = play.text.includes(' makes ');
        const textWeight = isMake ? 'fw-bold' : '';
        
        el.innerHTML = `
            <div class="fw-bold text-secondary me-2" style="white-space: nowrap; width: 50px; text-align: right; padding-top: 1px;">${play.time}</div>
            <div class="text-dark ${textWeight}" style="flex: 1; line-height: 1.3;" title="${play.text}">${play.text}</div>
        `;

        const isScrolled = listContainer.scrollTop > 5;
        const oldScrollHeight = listContainer.scrollHeight;
        listContainer.prepend(el);

        if (isScrolled) {
            const newScrollHeight = listContainer.scrollHeight;
            listContainer.scrollTop += (newScrollHeight - oldScrollHeight);
        }

        Array.from(listContainer.children).forEach((child, index) => {
            if (index % 2 === 0) {
                child.classList.remove('bg-white');
                child.classList.add('bg-light');
            } else {
                child.classList.remove('bg-light');
                child.classList.add('bg-white');
            }
        });
    }
}

function getRecentPlaysHtml(localId) {
    let plays = window.RENDERED_PBP[localId] || [];
    if (plays.length === 0) return '';

    let qs = new Set();
    plays.forEach(p => { if (p.period) qs.add(p.period.toString()); });
    let availableQs = Array.from(qs).map(Number).sort((a,b) => a-b).map(String);

    if (!window.CARD_STATE[localId]) window.CARD_STATE[localId] = {};
    let state = window.CARD_STATE[localId];

    if (!state.pbpTab) state.pbpTab = availableQs.length > 0 ? availableQs[availableQs.length - 1] : 'All';
    if (state.pbpTab !== 'All' && !availableQs.includes(state.pbpTab)) state.pbpTab = availableQs.length > 0 ? availableQs[availableQs.length - 1] : 'All';

    let activeTab = state.pbpTab;
    let isPbpOpen = state.pbpOpen === true; 

    let tabsHtml = `<div class="d-flex bg-light border-bottom border-top" style="overflow-x: auto; scrollbar-width: none;">
        <div class="px-3 py-1 fw-bold ${activeTab === 'All' ? 'text-dark border-bottom border-dark border-2' : 'text-muted'}" 
             style="font-size: 0.65rem; cursor: pointer; white-space: nowrap;" 
             onclick="switchPbpTab('${localId}', 'All')">All Plays</div>`;

    availableQs.forEach(q => {
        let periodNum = Number(q);
        let label = periodNum > 4 ? (periodNum === 5 ? 'OT' : `${periodNum - 4}OT`) : `${q}Q`;
        
        tabsHtml += `<div class="px-3 py-1 fw-bold ${activeTab === q ? 'text-dark border-bottom border-dark border-2' : 'text-muted'}" 
                          style="font-size: 0.65rem; cursor: pointer; white-space: nowrap;" 
                          onclick="switchPbpTab('${localId}', '${q}')">${label}</div>`;
    });
    tabsHtml += `</div>`;

    let filteredPlays = activeTab === 'All' ? plays : plays.filter(p => p.period.toString() === activeTab);

    if (state.hasFlippedPbp) filteredPlays = [...filteredPlays].reverse();

    let playsHtml = filteredPlays.map((play, i) => {
        const bgClass = i % 2 === 0 ? 'bg-light' : 'bg-white';
        const isMake = play.text.includes(' makes ');
        const textWeight = isMake ? 'fw-bold' : '';
        
        return `
        <div class="d-flex align-items-start ${bgClass} px-2 py-1" style="font-size: 0.65rem; border-bottom: 1px solid #f1f3f5;">
            <div class="fw-bold text-secondary me-2" style="white-space: nowrap; width: 50px; text-align: right; padding-top: 1px;">${play.time}</div>
            <div class="text-dark ${textWeight}" style="flex: 1; line-height: 1.3;" title="${play.text}">${play.text}</div>
        </div>`;
    }).join('');

    return `
        <div class="w-100">
            <div class="p-2 text-center border-bottom border-top text-muted fw-bold" onclick="togglePbpState('${localId}')" style="font-size: 0.70rem; cursor: pointer; background-color: #f8f9fa;">
                <span>${isPbpOpen ? 'Hide Recent Plays' : 'View Recent Plays'}</span> <span class="ms-1">${isPbpOpen ? '▲' : '▼'}</span>
            </div>
            <div style="display: ${isPbpOpen ? 'block' : 'none'};">
                ${tabsHtml}
                <div class="d-flex flex-column overflow-auto" id="pbp-list-${localId}" style="max-height: 130px; scrollbar-width: thin;">
                    ${playsHtml}
                </div>
            </div>
        </div>
    `;
}

// ==========================================
// CARD BUILDERS
// ==========================================
function createLineupCard(data) {
    const gameCard = document.createElement('div');
    gameCard.className = 'col-12 col-md-6 col-lg-4 px-1 mb-3';
    
    const { away, home, localId } = data;
    const platformNode = document.querySelector('input[name="dfsPlatform"]:checked');
    const platform = platformNode ? platformNode.value : 'fd';
    const selectedSlate = document.getElementById('slate-selector')?.value || 'all';

    if (!window.CARD_STATE[localId]) window.CARD_STATE[localId] = { baseBenchOpen: false, liveBenchOpen: false, pbpOpen: true };
    const cardState = window.CARD_STATE[localId];

    const liveMatch = LIVE_GAMES_DATA[localId];
    const isLiveDataAvailable = liveMatch && (liveMatch.status === 'in' || liveMatch.status === 'post');

    let timeBadgeHtml = `<span class="badge bg-dark text-white" style="font-size: 0.7rem;">${data.gameDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>`;
    if (isLiveDataAvailable) {
        if (liveMatch.status === 'in') {
            timeBadgeHtml = `<span class="badge bg-success text-white" style="font-size: 0.7rem;">LIVE</span>`;
        } else if (liveMatch.status === 'post') {
            timeBadgeHtml = `<span class="badge bg-secondary text-white" style="font-size: 0.7rem;">FINAL</span>`;
        }
    }

    const centerHtml = `
        <div class="badge bg-light text-dark border w-100 mb-1" style="font-size: 0.75rem;">${data.odds.spread}</div>
        <div class="badge bg-secondary text-white w-100" style="font-size: 0.70rem;">${data.odds.overUnder}</div>
    `;

    const buildBaseLineupList = (players, isProjected, isBench = false) => {
        if (!players || !players.length) return { html: isBench ? '' : `<div class="p-4 text-center text-muted small fw-bold">Lineup pending...</div>`, hasValidPlayers: false };
        
        const fixedPositions = ['PG', 'SG', 'SF', 'PF', 'C'];
        let hasValidPlayersForList = false;
        
        let headerHtml = '';
        if (!isBench) {
            const color = isProjected ? "#ffecb5" : "#198754";
            const textColor = isProjected ? "text-dark" : "text-white";
            const label = isProjected ? "⚠️ PROJECTED" : "✅ OFFICIAL";
            headerHtml = `<div class="text-center py-1 fw-bold border-bottom ${textColor}" style="font-size: 0.6rem; background-color: ${color};">${label}</div>`;
        }
        
        let generatedItemsCount = 0;
        const items = players.map((p, index) => {
            const a = p.athlete || p;
            let rawPos = (a.dfs && a.dfs.pos) ? a.dfs.pos : (a.position?.abbreviation || 'Flex');
            if (platform === 'dk' && a.dfs && a.dfs.dk_pos) rawPos = a.dfs.dk_pos;
            const displayPos = isBench ? rawPos : (fixedPositions[index] || 'Flex');
            
            let showStats = false, salFmt = '-', projFmt = '-', valFmt = '-';
            
            if (a.dfs) {
                const slatesDict = platform === 'dk' ? (a.dfs.dk_slates || {}) : (a.dfs.fd_slates || {});
                let sal = 0, proj = 0, val = 0;
                
                if (selectedSlate !== 'all' && slatesDict[selectedSlate]) {
                    sal = slatesDict[selectedSlate].salary; proj = slatesDict[selectedSlate].proj; val = slatesDict[selectedSlate].value;
                    showStats = true; hasValidPlayersForList = true;
                } else if (selectedSlate === 'all') {
                    sal = platform === 'dk' ? a.dfs.dk_salary : a.dfs.salary; proj = platform === 'dk' ? a.dfs.dk_proj : a.dfs.proj; val = platform === 'dk' ? a.dfs.dk_value : a.dfs.value;
                    if (sal > 0 || proj > 0) { showStats = true; hasValidPlayersForList = true; }
                }
                if (showStats) {
                    salFmt = sal > 0 ? (sal / 1000).toFixed(1) + 'k' : '-';
                    projFmt = proj > 0 ? proj : '-';
                    valFmt = val > 0 ? val : '-';
                }
            }
            
            let playerName = a.displayName || a.fullName || 'Unknown';
            if (playerName !== 'Unknown' && playerName.includes(' ')) playerName = `${playerName.charAt(0)}. ${playerName.split(' ').slice(1).join(' ')}`;
            if (isBench && selectedSlate !== 'all' && !showStats) return '';
            
            generatedItemsCount++;
            return `
            <li class="px-0 py-1 border-bottom d-flex align-items-center justify-content-between" style="overflow: hidden;">
                <div class="d-flex align-items-center" style="width: 53%; overflow: hidden;">
                    <span class="text-muted me-1 text-center" style="font-size: 0.7rem; width: 16px; flex-shrink: 0;">${displayPos}</span>
                    <span class="text-truncate fw-bold text-dark" style="font-size: 0.75rem;" title="${a.displayName || a.fullName}">${playerName}</span>
                </div>
                ${showStats ? `
                <div class="d-flex align-items-center justify-content-end text-muted" style="width: 47%; font-size: 0.7rem; letter-spacing: -0.4px;">
                    <span style="width: 32%; text-align: right;">${salFmt}</span>
                    <span style="width: 36%; text-align: center;">${projFmt}</span>
                    <span style="width: 32%; text-align: left;">${valFmt}</span>
                </div>` : `<div style="width: 47%;"></div>`}
            </li>`;
        }).join('');
        
        if (isBench && generatedItemsCount === 0) return { html: '', hasValidPlayers: false };
        return { html: `${headerHtml}<ul class="list-unstyled m-0">${items}</ul>`, hasValidPlayers: hasValidPlayersForList };
    };

    const awayBaseStarters = buildBaseLineupList(data.awayStarters, data.awayIsProjected, false);
    const homeBaseStarters = buildBaseLineupList(data.homeStarters, data.homeIsProjected, false);
    const awayBaseBench = buildBaseLineupList(data.awayBench, false, true);
    const homeBaseBench = buildBaseLineupList(data.homeBench, false, true);
    
    const hasAnySlatePlayer = hasAnyDfsSalaries(data, platform);

    let missingSlateHtml = '';
    const platKey = platform === 'dk' ? 'draftkings' : 'fanduel';
    if (!hasAnySlatePlayer && selectedSlate === 'all') {
        if (ALL_SLATES[platKey] && ALL_SLATES[platKey].length > 0) {
            missingSlateHtml = `<div class="w-100 text-center py-1 fw-bold text-white bg-secondary border-top" style="font-size: 0.65rem;">🚫 Game not included in ${platform === 'dk' ? 'DK' : 'FD'} slates</div>`;
        } else {
            missingSlateHtml = `<div class="w-100 text-center py-1 fw-bold text-dark border-top" style="font-size: 0.65rem; background-color: #ffecb5;">⏳ ${platform === 'dk' ? 'DK' : 'FD'} salaries & slates pending...</div>`;
        }
    }

    let baseBenchHtml = '';
    if (awayBaseBench.html || homeBaseBench.html) {
        baseBenchHtml = `
            <div class="border-top bg-light">
                <div class="p-2 text-center border-bottom text-muted fw-bold bench-toggle" onclick="toggleBenchState('${localId}', 'base')" style="font-size: 0.70rem; cursor: pointer; background-color: #f8f9fa;">
                    <span>View Bench Options</span> <span class="bench-arrow ms-1">${cardState.baseBenchOpen ? '▲' : '▼'}</span>
                </div>
                <div class="row g-0 bench-container" style="display: ${cardState.baseBenchOpen ? 'flex' : 'none'};">
                    <div class="col-6 border-end">${awayBaseBench.html}</div>
                    <div class="col-6">${homeBaseBench.html}</div>
                </div>
            </div>`;
    }

    gameCard.innerHTML = `
        <div class="lineup-card shadow-sm border rounded bg-white overflow-hidden" id="game-${data.localId}">
            <div class="p-2 border-bottom d-flex justify-content-between align-items-center bg-light">
                <div class="d-flex align-items-center">
                    ${timeBadgeHtml}
                </div>
                <span class="text-muted fw-bold text-uppercase" style="font-size: 0.6rem;">${data.venue}</span>
            </div>
            
            <div class="p-2 d-flex align-items-center justify-content-between text-center border-bottom">
                <div style="width: 30%;">
                    <img src="${away.team.logo}" style="width: 45px;">
                    <div class="fw-bold mt-1 text-truncate text-dark" style="font-size: 0.7rem;">${away.team.shortDisplayName}</div>
                </div>
                <div style="width: 40%; padding: 0 10px;">
                    ${centerHtml}
                </div>
                <div style="width: 30%;">
                    <img src="${home.team.logo}" style="width: 45px;">
                    <div class="fw-bold mt-1 text-truncate text-dark" style="font-size: 0.7rem;">${home.team.shortDisplayName}</div>
                </div>
            </div>
            
            ${missingSlateHtml}
            
            <div class="row g-0">
                <div class="col-6 border-end">${awayBaseStarters.html}</div>
                <div class="col-6">${homeBaseStarters.html}</div>
            </div>
            
            ${baseBenchHtml}
        </div>`;
        
    return gameCard;
}

function createLiveCard(data) {
    const gameCard = document.createElement('div');
    gameCard.className = 'col-12 col-md-6 col-lg-4 px-1 mb-3';
    
    const { away, home, localId } = data;
    const platformNode = document.querySelector('input[name="dfsPlatform"]:checked');
    const platform = platformNode ? platformNode.value : 'fd';
    
    const awayStd = getStandardAbbr(away.team.abbreviation);
    const homeStd = getStandardAbbr(home.team.abbreviation);

    const liveMatch = LIVE_GAMES_DATA[localId];
    const isActivelyPlaying = liveMatch && liveMatch.status === 'in'; 

    if (!window.CARD_STATE[localId]) window.CARD_STATE[localId] = { baseBenchOpen: false, liveBenchOpen: false, pbpOpen: true };
    const cardState = window.CARD_STATE[localId];

    let timeBadgeHtml = "";
    if (liveMatch && liveMatch.status === 'in') {
        timeBadgeHtml = `<span class="badge bg-success text-white" style="font-size: 0.7rem;">LIVE</span>`;
    } else if (liveMatch && liveMatch.status === 'post') {
        timeBadgeHtml = `<span class="badge bg-secondary text-white" style="font-size: 0.7rem;">FINAL</span>`;
    }

    const pulseHtml = isActivelyPlaying ? `<span class="spinner-grow spinner-grow-sm text-success slow-pulse" style="width: 0.45rem; height: 0.45rem; margin-right: 4px;"></span>` : '';
    const badgeColor = isActivelyPlaying ? 'text-success border-success' : 'text-secondary border-secondary';

    const currentAwayScore = liveMatch && liveMatch.away_score !== undefined ? liveMatch.away_score : (away.score || 0);
    const currentHomeScore = liveMatch && liveMatch.home_score !== undefined ? liveMatch.home_score : (home.score || 0);

    const clockDisplay = liveMatch ? liveMatch.clock : "0.0";
    const scoreHtml = `
        <div class="fw-bold text-dark mb-1" style="font-size: 1.2rem; letter-spacing: -0.5px;">
            ${currentAwayScore} - ${currentHomeScore}
        </div>
        <div class="badge bg-light ${badgeColor} border w-100 d-inline-flex align-items-center justify-content-center" style="font-size: 0.7rem; border-radius: 12px; padding-top: 4px; padding-bottom: 4px;">
            ${pulseHtml}<span>${clockDisplay}</span>
        </div>`;

    const awayColor = away.team.color ? '#' + away.team.color : '#cccccc';
    const homeColor = home.team.color ? '#' + home.team.color : '#cccccc';

    let awayStatsHtml = `<div style="width: 14%;"></div>`;
    let homeStatsHtml = `<div style="width: 14%;"></div>`;

    if (liveMatch && liveMatch.team_stats) {
        const aStats = liveMatch.team_stats[awayStd] || {};
        const hStats = liveMatch.team_stats[homeStd] || {};
        
        const formatStatLeft = (label, val) => `
            <div class="d-flex mb-1" style="gap: 4px;">
                <span class="text-secondary text-start" style="font-size: 0.55rem; width: 22px;">${label}</span>
                <span class="text-dark text-start">${val || '-'}</span>
            </div>`;
            
        const formatStatRight = (label, val) => `
            <div class="d-flex justify-content-end mb-1" style="gap: 4px;">
                <span class="text-dark text-end">${val || '-'}</span>
                <span class="text-secondary text-end" style="font-size: 0.55rem; width: 22px;">${label}</span>
            </div>`;

        awayStatsHtml = `
            <div style="width: 14%; font-size: 0.65rem; line-height: 1.1;" class="fw-bold ms-1">
                ${formatStatLeft('FG%', aStats['FG%'])}
                ${formatStatLeft('3P%', aStats['3P%'])}
                ${formatStatLeft('REB', aStats['REB'])}
                ${formatStatLeft('AST', aStats['AST'])}
                ${formatStatLeft('TO', aStats['TO'])}
            </div>`;
            
        homeStatsHtml = `
            <div style="width: 14%; font-size: 0.65rem; line-height: 1.1;" class="fw-bold me-1">
                ${formatStatRight('FG%', hStats['FG%'])}
                ${formatStatRight('3P%', hStats['3P%'])}
                ${formatStatRight('REB', hStats['REB'])}
                ${formatStatRight('AST', hStats['AST'])}
                ${formatStatRight('TO', hStats['TO'])}
            </div>`;
    }

    const buildLiveCourtGrid = (teamAbbr, liveTeamData) => {
        if (!liveTeamData) return { onCourtHtml: '', benchHtml: '' };
        
        let allPlayers = [];
        for (const [playerName, stats] of Object.entries(liveTeamData)) {
            allPlayers.push({ name: playerName, live: stats });
        }

        const fpKey = platform === 'dk' ? 'dk_pts' : 'fd_pts';

        let onCourt = allPlayers.filter(p => p.live && p.live.is_on_court === true);
        let bench = allPlayers.filter(p => !p.live || p.live.is_on_court !== true);

        onCourt.sort((a, b) => (b.live[fpKey] || 0) - (a.live[fpKey] || 0));
        bench.sort((a, b) => (b.live[fpKey] || 0) - (a.live[fpKey] || 0));

        const renderRow = (p) => {
            let fp = (p.live[fpKey] || 0).toFixed(1);
            let shortName = p.name.includes(' ') ? `${p.name.charAt(0)}. ${p.name.split(' ').slice(1).join(' ')}` : p.name;
            return `
                <div class="d-flex border-bottom py-1 align-items-center" style="font-size: 0.75rem; min-width: 320px;">
                    <div class="fw-bold text-truncate pe-1 ps-2 bg-white" style="width: 85px; position: sticky; left: 0; z-index: 2; border-right: 1px solid #dee2e6;" title="${p.name}">${shortName}</div>
                    <div class="fw-bold text-success text-center" style="width: 35px;">${fp}</div>
                    <div class="text-center text-muted" style="width: 35px; font-size: 0.65rem;">${p.live.MIN}</div>
                    <div class="text-center fw-bold text-dark" style="width: 30px;">${p.live.PTS}</div>
                    <div class="text-center fw-bold text-dark" style="width: 30px;">${p.live.REB}</div>
                    <div class="text-center fw-bold text-dark" style="width: 30px;">${p.live.AST}</div>
                    <div class="text-center text-muted" style="width: 30px;">${p.live.STL}</div>
                    <div class="text-center text-muted" style="width: 30px;">${p.live.BLK}</div>
                    <div class="text-center text-muted" style="width: 30px;">${p.live.TO}</div>
                </div>
            `;
        };

        const headerHtml = `
            <div class="d-flex border-bottom py-1 align-items-center text-muted fw-bold" style="font-size: 0.65rem; min-width: 320px; background-color: #f1f3f5;">
                <div style="width: 85px; position: sticky; left: 0; background: #f1f3f5; z-index: 2; border-right: 1px solid #dee2e6;" class="ps-2 text-dark">ON COURT</div>
                <div class="text-center text-dark" style="width: 35px;">FP</div>
                <div class="text-center" style="width: 35px;">MIN</div>
                <div class="text-center" style="width: 30px;">PTS</div>
                <div class="text-center" style="width: 30px;">REB</div>
                <div class="text-center" style="width: 30px;">AST</div>
                <div class="text-center" style="width: 30px;">STL</div>
                <div class="text-center" style="width: 30px;">BLK</div>
                <div class="text-center" style="width: 30px;">TO</div>
            </div>
        `;

        const benchHeaderHtml = headerHtml.replace("ON COURT", "BENCH");

        let onCourtHtml = onCourt.length > 0 ? onCourt.map(renderRow).join('') : `<div class="text-center text-muted py-2 small" style="min-width: 320px;">Scanning...</div>`;
        let benchHtml = bench.map(renderRow).join('');

        return {
            onCourtHtml: `<div class="overflow-auto live-table-wrapper" id="live-oncourt-${teamAbbr}">${headerHtml}${onCourtHtml}</div>`,
            benchHtml: `<div class="overflow-auto live-table-wrapper" id="live-bench-${teamAbbr}">${benchHeaderHtml}${benchHtml}</div>`
        };
    };

    let awayLiveGrid = { onCourtHtml: '', benchHtml: '' };
    let homeLiveGrid = { onCourtHtml: '', benchHtml: '' };
    
    if (liveMatch && liveMatch.players) {
        awayLiveGrid = buildLiveCourtGrid(awayStd, liveMatch.players[awayStd]);
        homeLiveGrid = buildLiveCourtGrid(homeStd, liveMatch.players[homeStd]);
    }

    let liveBenchToggleHtml = '';
    if (awayLiveGrid.benchHtml || homeLiveGrid.benchHtml) {
        liveBenchToggleHtml = `
            <div class="border-top bg-light">
                <div class="p-2 text-center border-bottom text-muted fw-bold bench-toggle" onclick="toggleBenchState('${localId}', 'live')" style="font-size: 0.70rem; cursor: pointer; background-color: #f8f9fa;">
                    <span>View Live Bench</span> <span class="bench-arrow ms-1">${cardState.liveBenchOpen ? '▲' : '▼'}</span>
                </div>
                <div class="row g-0 bench-container" style="display: ${cardState.liveBenchOpen ? 'flex' : 'none'};">
                    <div class="col-6 border-end w-50 overflow-hidden">${awayLiveGrid.benchHtml}</div>
                    <div class="col-6 w-50 overflow-hidden">${homeLiveGrid.benchHtml}</div>
                </div>
            </div>`;
    }

    gameCard.innerHTML = `
        <div class="lineup-card shadow-sm border rounded bg-white overflow-hidden" id="game-${data.localId}">
            <div class="p-2 border-bottom d-flex justify-content-between align-items-center bg-light">
                <div class="d-flex align-items-center">
                    ${timeBadgeHtml}
                </div>
                <span class="text-muted fw-bold text-uppercase" style="font-size: 0.6rem;">${data.venue}</span>
            </div>
            
            <div class="p-2 d-flex align-items-center justify-content-between text-center" style="background: linear-gradient(90deg, ${awayColor}26 0%, ${awayColor}26 50%, ${homeColor}26 50%, ${homeColor}26 100%);">
                ${awayStatsHtml}
                <div style="width: 20%;">
                    <img src="${away.team.logo}" style="width: 45px;">
                    <div class="fw-bold mt-1 text-truncate text-dark" style="font-size: 0.7rem;">${away.team.shortDisplayName}</div>
                </div>
                <div style="width: 32%;">
                    ${scoreHtml}
                </div>
                <div style="width: 20%;">
                    <img src="${home.team.logo}" style="width: 45px;">
                    <div class="fw-bold mt-1 text-truncate text-dark" style="font-size: 0.7rem;">${home.team.shortDisplayName}</div>
                </div>
                ${homeStatsHtml}
            </div>

            ${getRecentPlaysHtml(localId)}

            <div class="row g-0 border-top bg-white">
                <div class="col-6 border-end w-50 overflow-hidden">${awayLiveGrid.onCourtHtml}</div>
                <div class="col-6 w-50 overflow-hidden">${homeLiveGrid.onCourtHtml}</div>
            </div>
            ${liveBenchToggleHtml}
        </div>`;
        
    return gameCard;
}

// ==========================================
// EVENT LISTENERS
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    init(DEFAULT_DATE);
    
    document.getElementById('team-search')?.addEventListener('input', renderGames);
    document.getElementById('date-picker')?.addEventListener('change', (e) => {
        init(e.target.value);
        e.target.blur();
    });
    
    document.querySelectorAll('.dfs-toggle').forEach(radio => radio.addEventListener('change', () => {
        populateSlates();
        renderGames();
    }));
    
    document.getElementById('slate-selector')?.addEventListener('change', renderGames);
});
