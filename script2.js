// ==========================================
// CONFIGURATION
// ==========================================
const DEFAULT_DATE = new Date().toLocaleDateString('en-CA');
let ALL_GAMES_DATA = []; 
let LIVE_GAMES_DATA = {}; 
let ALL_SLATES = { fanduel: [], draftkings: [] };
let ARE_ALL_EXPANDED = false;

// State managers
window.MASTER_TAB = 'lineups'; // Default master tab
window.CARD_STATE = {}; 
window.RENDERED_PBP = {}; 
window.PBP_QUEUE = {};    
window.LAST_SEQ_SEEN = {}; 
window.PENDING_LIVE_DATA = {}; 
window.GAME_QUEUE_TIMERS = {}; 
let livePollInterval;

// Global CSS injection for pulse and the new sliding animation
const style = document.createElement('style');
style.innerHTML = `
    .slow-pulse { animation: spinner-grow 2s linear infinite !important; }
    
    @keyframes slideInHighlight {
        0% { background-color: #d1e7dd; transform: translateY(-5px); opacity: 0; }
        10% { transform: translateY(0); opacity: 1; }
        100% { background-color: transparent; }
    }
    .new-play-anim { animation: slideInHighlight 3.5s ease-out; }
`;
document.head.appendChild(style);

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
                        // Only render if the user is actually looking at the LIVE tab!
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

        if (!state.highestPeriodSeen || playPeriod > state.highestPeriodSeen) {
            state.highestPeriodSeen = playPeriod;
            state.pbpTab = playPeriod.toString();
            switchedQuarter = true;
        }

        // Only manipulate the DOM if we are actively on the Live tab
        if (window.MASTER_TAB === 'live') {
            if (switchedQuarter) {
                renderGames();
            } else {
                injectPlayIntoDOM(localId, playToInject);
            }
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
                        if (fullLog.length > 0) window.CARD_STATE[localId].highestPeriodSeen = Math.max(...fullLog.map(p => Number(p.period)));
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
                    LIVE_GAMES_DATA[localId] = game;
                    needsGlobalRender = true;
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
                        gameObj.awayStarters = localGameMatch.rosters[awayStd].players.map(p => ({ athlete: { displayName: p.name, position: { abbreviation: p.pos }, dfs: p } }));
                    }
                    if (localGameMatch.rosters[homeStd] && localGameMatch.rosters[homeStd].players) {
                        const isVerified = localGameMatch.rosters[homeStd].players.every(p => p.verified === true);
                        if (gameObj.homeIsProjected !== !isVerified) {
                            gameObj.homeIsProjected = !isVerified;
                            needsGlobalRender = true;
                        }
                        gameObj.homeStarters = localGameMatch.rosters[homeStd].players.map(p => ({ athlete: { displayName: p.name, position: { abbreviation: p.pos }, dfs: p } }));
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

    // Inject the Master Tabs dynamically next to the slate selector
    const tabContainer = document.createElement('div');
    tabContainer.id = 'master-tab-container';
    tabContainer.className = 'd-inline-block ms-3 align-middle';
    tabContainer.innerHTML = `
        <div class="btn-group" role="group">
            <input type="radio" class="btn-check" name="masterTab" id="tab-lineups" value="lineups" checked>
            <label class="btn btn-outline-dark btn-sm fw-bold shadow-sm" for="tab-lineups">Lineups 📋</label>

            <input type="radio" class="btn-check" name="masterTab" id="tab-live" value="live">
            <label class="btn btn-outline-success btn-sm fw-bold shadow-sm" for="tab-live">Live Games 🟢</label>
        </div>
    `;
    
    slateSelector.parentNode.insertBefore(tabContainer, slateSelector.nextSibling);

    document.querySelectorAll('input[name="masterTab"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            window.MASTER_TAB = e.target.value;
            renderGames(); // Immediately swap the view
        });
    });
}

// Helper to determine if a game has any players in the currently selected DFS slate
function hasSlatePlayers(game, platform, slateId) {
    if (slateId === 'all') return true; // If 'all', we don't filter the game out entirely.
    
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

// Helper to determine if a game has ANY dfs players at all (for the missing slate warning)
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
    const dateToFetch = datePicker ? datePicker.value : new Date().toLocaleDateString('en-CA');
    
    const [y, m, d] = dateToFetch.split('-');
    const dateObj = new Date(y, m - 1, d);
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
    
    if(Array.from(selector.options).some(opt => opt.value === currentVal)) {
        selector.value = currentVal;
    } else {
        selector.value = 'all';
    }

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
    
    const espnDate = dateToFetch.replace(/-/g, '');
    const ESPN_API_URL = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${espnDate}`;
    
    try {
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
                
                if (localPlayers && localPlayers.every(p => p.verified)) {
                    starters = localPlayers.map(p => ({ athlete: { displayName: p.name, position: { abbreviation: p.pos }, dfs: p } }));
                    isProj = false;
                } else if (teamData.starters) {
                    starters = teamData.starters; isProj = false;
                } else if (localPlayers) {
                    starters = localPlayers.map(p => ({ athlete: { displayName: p.name, position: { abbreviation: p.pos }, dfs: p } }));
                }
                if (localBench) bench = localBench.map(p => ({ athlete: { displayName: p.name, position: { abbreviation: p.pos }, dfs: p } }));
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
                gameDate: new Date(game.date), status: game.status.type.detail,
                localId: localId
            });
        });

        renderGames();
        
        await pollLiveData(dateToFetch);
        clearInterval(livePollInterval);
        livePollInterval = setInterval(() => pollLiveData(dateToFetch), 30000);

    } catch (error) {
        console.error("Init error:", error);
        if (container) container.innerHTML = `<div class="col-12 text-center mt-5"><div class="alert alert-danger">Failed to load schedule.</div></div>`;
    }
}

function renderGames() {
    const container = document.getElementById('games-container');
    if (!container) return;
    
    const platformNode = document.querySelector('input[name="dfsPlatform"]:checked');
    const platform = platformNode ? platformNode.value : 'fd';
    const selectedSlate = document.getElementById('slate-selector')?.value || 'all';

    // Save scroll state for live grid tables
    const scrollPositions = {};
    document.querySelectorAll('.live-table-wrapper').forEach(el => {
        scrollPositions[el.id] = el.scrollLeft;
    });

    container.innerHTML = '';
    const searchText = document.getElementById('team-search')?.value.toLowerCase() || '';
    
    // Base Filter: Text Search
    let filteredData = ALL_GAMES_DATA.filter(item => 
        (item.away.team.displayName + " " + item.home.team.displayName).toLowerCase().includes(searchText)
    );

    // Filter by DFS Slate Selection!
    if (selectedSlate !== 'all') {
        filteredData = filteredData.filter(item => hasSlatePlayers(item, platform, selectedSlate));
    }

    // Master Tab Filter: If "Live", hide games that haven't tipped off
    if (window.MASTER_TAB === 'live') {
        filteredData = filteredData.filter(item => {
            const liveMatch = LIVE_GAMES_DATA[item.localId];
            return liveMatch && (liveMatch.status === 'in' || liveMatch.status === 'post');
        });
    }

    if (filteredData.length === 0) {
        let msg = window.MASTER_TAB === 'live' ? "No games are currently live or completed." : "No games match your filters.";
        container.innerHTML = `<div class="col-12 text-center py-5 text-muted fw-bold">${msg}</div>`;
        return;
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
        // Route to the appropriate card builder based on the Master Tab
        const card = window.MASTER_TAB === 'lineups' ? createLineupCard(item) : createLiveCard(item);
        if (card) container.appendChild(card);
    });

    // Restore scroll state
    document.querySelectorAll('.live-table-wrapper').forEach(el => {
        if (scrollPositions[el.id]) el.scrollLeft = scrollPositions[el.id];
    });
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

        listContainer.prepend(el);

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
// CARD BUILDER 1: LINEUPS (DFS Research View)
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

    // Time Badge Logic (Changes to LIVE or FINAL)
    let timeBadgeHtml = `<span class="badge bg-dark text-white" style="font-size: 0.7rem;">${data.gameDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>`;
    if (isLiveDataAvailable) {
        if (liveMatch.status === 'in') {
            timeBadgeHtml = `<span class="badge bg-success text-white" style="font-size: 0.7rem;">LIVE</span>`;
        } else if (liveMatch.status === 'post') {
            timeBadgeHtml = `<span class="badge bg-secondary text-white" style="font-size: 0.7rem;">FINAL</span>`;
        }
    }

    // Center Display Logic: We want to ALWAYS show the Odds on the Lineups tab. 
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
            let rawPos = (a.dfs && a.dfs.pos) ? a.dfs.pos : (a.position ? a.position.abbreviation : 'Flex');
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

// ==========================================
// CARD BUILDER 2: LIVE (Sweat View)
// ==========================================
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

    if (!window.CARD_STATE[localId]) window.CARD_STATE[localId] = { liveBenchOpen: false, pbpOpen: false };
    const cardState = window.CARD_STATE[localId];

    let timeBadgeHtml = "";
    if (liveMatch.status === 'in') {
        timeBadgeHtml = `<span class="badge bg-success text-white" style="font-size: 0.7rem;">LIVE</span>`;
    } else if (liveMatch.status === 'post') {
        timeBadgeHtml = `<span class="badge bg-secondary text-white" style="font-size: 0.7rem;">FINAL</span>`;
    }

    const pulseHtml = isActivelyPlaying ? `<span class="spinner-grow spinner-grow-sm text-success slow-pulse" style="width: 0.45rem; height: 0.45rem; margin-right: 4px;"></span>` : '';
    const badgeColor = isActivelyPlaying ? 'text-success border-success' : 'text-secondary border-secondary';

    const currentAwayScore = liveMatch.away_score !== undefined ? liveMatch.away_score : (away.score || 0);
    const currentHomeScore = liveMatch.home_score !== undefined ? liveMatch.home_score : (home.score || 0);

    const scoreHtml = `
        <div class="fw-bold text-dark mb-1" style="font-size: 1.2rem; letter-spacing: -0.5px;">
            ${currentAwayScore} - ${currentHomeScore}
        </div>
        <div class="badge bg-light ${badgeColor} border w-100 d-inline-flex align-items-center justify-content-center" style="font-size: 0.7rem; border-radius: 12px; padding-top: 4px; padding-bottom: 4px;">
            ${pulseHtml}<span>${liveMatch.clock}</span>
        </div>`;

    const awayColor = away.team.color ? '#' + away.team.color : '#cccccc';
    const homeColor = home.team.color ? '#' + home.team.color : '#cccccc';

    let awayStatsHtml = `<div style="width: 14%;"></div>`;
    let homeStatsHtml = `<div style="width: 14%;"></div>`;

    if (liveMatch.team_stats) {
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
    
    if (liveMatch.players) {
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
