// ==========================================
// CONFIGURATION
// ==========================================
const DEFAULT_DATE = new Date().toLocaleDateString('en-CA');
let ALL_GAMES_DATA = []; 
let LIVE_GAMES_DATA = {}; 
let ALL_SLATES = { fanduel: [], draftkings: [] };
let ARE_ALL_EXPANDED = false;

// State manager to prevent tabs/benches from closing when the 30-sec live poll updates the DOM
window.CARD_STATE = {}; 
let livePollInterval;

// Global CSS injection for the slower pulse animation
const style = document.createElement('style');
style.innerHTML = `.slow-pulse { animation: spinner-grow 2s linear infinite !important; }`;
document.head.appendChild(style);

// ==========================================
// 1. MAIN APP LOGIC 
// ==========================================

function normalizeName(name) {
    if (!name) return "";
    let normalized = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z]/g, "").toLowerCase();
    const nameMap = {
        "gregoryjackson": "ggjackson",
        "ggjacksonii": "gregoryjackson",
        "gregoryjacksonii": "gregoryjackson",
        "pjwashington": "pjwashingtonjr", 
        "timhardaway": "timhardawayjr",
        "xaviertillman": "xaviertillmansr",
        "mohamedbamba": "mobamba"
    };
    return nameMap[normalized] || normalized;
}

function getStandardAbbr(abbr) {
    if (!abbr) return "";
    let cleanAbbr = abbr.replace(/[^A-Za-z]/g, '').toUpperCase();
    const map = {
        "NY": "NYK", "NO": "NOP", "SA": "SAS", "GS": "GSW", "WSH": "WAS", "UTAH": "UTA"
    };
    return map[cleanAbbr] || cleanAbbr;
}

// FETCH BASE JSON
async function fetchLocalProbables(dateToFetch) {
    try {
        const response = await fetch(`data/${dateToFetch}.json?v=` + new Date().getTime());
        if (response.ok) return await response.json();
    } catch (e) {
        console.log(`No daily JSON found for ${dateToFetch}.`);
    }
    return { games: [], slates: { fanduel: [], draftkings: [] }, espn_schedule: null };
}

// FETCH LIVE JSON (Polled every 30s)
async function pollLiveData(dateToFetch) {
    try {
        const response = await fetch(`data/LIVE/live_${dateToFetch}.json?v=` + new Date().getTime(), { cache: 'no-store' });
        if (response.ok) {
            LIVE_GAMES_DATA = await response.json();
            renderGames(); // Re-render gracefully
        }
    } catch (e) {
        // Silently fail if live data isn't generated yet
    }
}

// ==========================================
// 2. TOGGLE LOGIC & STATE MANAGEMENT
// ==========================================

window.toggleGameTab = function(localId, tabName) {
    if (!window.CARD_STATE[localId]) window.CARD_STATE[localId] = {};
    window.CARD_STATE[localId].tab = tabName;
    renderGames();
};

window.toggleBenchState = function(localId, viewType) {
    if (!window.CARD_STATE[localId]) window.CARD_STATE[localId] = {};
    const key = viewType + 'BenchOpen';
    window.CARD_STATE[localId][key] = !window.CARD_STATE[localId][key];
    renderGames();
};

// ==========================================
// 3. UI RENDERING & DEEP LINKS
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
        
        // Initial Fetch for Live Data, then start 30s polling
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
    
    // Save Horizontal Scroll Positions before re-rendering so the UI doesn't snap back
    const scrollPositions = {};
    document.querySelectorAll('.live-table-wrapper').forEach(el => {
        scrollPositions[el.id] = el.scrollLeft;
    });

    container.innerHTML = '';
    const searchText = document.getElementById('team-search')?.value.toLowerCase() || '';
    
    ALL_GAMES_DATA.filter(item => (item.away.team.displayName + " " + item.home.team.displayName).toLowerCase().includes(searchText))
        .sort((a, b) => a.gameDate - b.gameDate)
        .forEach(item => {
            const card = createGameCard(item);
            if (card) container.appendChild(card);
        });

    // Restore Horizontal Scroll Positions
    document.querySelectorAll('.live-table-wrapper').forEach(el => {
        if (scrollPositions[el.id]) el.scrollLeft = scrollPositions[el.id];
    });
}

function getLiveTeamStatsHtml(away, home, liveData) {
    if (!liveData || !liveData.team_stats) return '';
    const aStats = liveData.team_stats[getStandardAbbr(away.team.abbreviation)] || {};
    const hStats = liveData.team_stats[getStandardAbbr(home.team.abbreviation)] || {};

    const buildBar = (label, aVal, hVal) => {
        const a = parseFloat(aVal) || 0;
        const h = parseFloat(hVal) || 0;
        const total = a + h;
        let aPct = 50, hPct = 50;
        if (total > 0) { aPct = (a / total) * 100; hPct = (h / total) * 100; }
        
        // Sleeker Dashboard Look: 4px height, inset shadow on the track, rounded outer corners on fills
        return `
        <div class="mb-2 w-100">
            <div class="d-flex justify-content-between align-items-center mb-1" style="font-size: 0.6rem; font-weight: 800;">
                <span class="text-muted">${aVal || '0'}</span>
                <span class="text-dark" style="letter-spacing: 0.5px; opacity: 0.8;">${label}</span>
                <span class="text-muted">${hVal || '0'}</span>
            </div>
            <div class="d-flex w-100" style="height: 4px; background: rgba(0,0,0,0.06); border-radius: 4px; box-shadow: inset 0 1px 2px rgba(0,0,0,0.08);">
                <div style="width: ${aPct}%; background: #${away.team.color || '6c757d'}; border-radius: 4px 0 0 4px;"></div>
                <div style="width: ${hPct}%; background: #${home.team.color || '198754'}; border-radius: 0 4px 4px 0;"></div>
            </div>
        </div>`;
    };

    // 2-Column Layout (3 stats on left, 3 stats on right)
    return `
        <div class="row g-0 w-100 pb-2 pt-2 px-3 mx-0">
            <div class="col-6 pe-3 border-end">
                ${buildBar("FG%", aStats["FG%"], hStats["FG%"])}
                ${buildBar("3P%", aStats["3P%"], hStats["3P%"])}
                ${buildBar("REB", aStats["REB"], hStats["REB"])}
            </div>
            <div class="col-6 ps-3">
                ${buildBar("AST", aStats["AST"], hStats["AST"])}
                ${buildBar("STL", aStats["STL"], hStats["STL"])}
                ${buildBar("TO", aStats["TO"], hStats["TO"])}
            </div>
        </div>
    `;
}

function createGameCard(data) {
    const gameCard = document.createElement('div');
    gameCard.className = 'col-12 col-md-6 col-lg-4 px-1 mb-3';
    
    const { away, home, gameRaw, localId } = data;
    const platformNode = document.querySelector('input[name="dfsPlatform"]:checked');
    const platform = platformNode ? platformNode.value : 'fd';
    const selectedSlate = document.getElementById('slate-selector')?.value || 'all';

    // Check Live Data Status
    const liveMatch = LIVE_GAMES_DATA[localId];
    const isLiveDataAvailable = liveMatch && (liveMatch.status === 'in' || liveMatch.status === 'post');
    const isActivelyPlaying = liveMatch && liveMatch.status === 'in'; // Only true while clock is ticking
    
    // Initialize State for this card if it doesn't exist
    if (!window.CARD_STATE[localId]) {
        window.CARD_STATE[localId] = { 
            tab: isLiveDataAvailable ? 'live' : 'starters', 
            baseBenchOpen: false, 
            liveBenchOpen: false 
        };
    }
    const cardState = window.CARD_STATE[localId];
    if (isLiveDataAvailable && !window.CARD_STATE[localId].everBeenLive) {
        cardState.tab = 'live';
        window.CARD_STATE[localId].everBeenLive = true;
    }

    let scoreOrOddsHtml = "";
    if (isLiveDataAvailable) {
        // Stop the blinking dot and mute the badge color if the game is 'post' (Final)
        const pulseHtml = isActivelyPlaying ? `<span class="spinner-grow spinner-grow-sm text-success slow-pulse" style="width: 0.45rem; height: 0.45rem; margin-right: 4px;"></span>` : '';
        const badgeColor = isActivelyPlaying ? 'text-success border-success' : 'text-secondary border-secondary';

        // Check if our Python script provided a live score, otherwise fall back to the initial page load score
        const currentAwayScore = liveMatch.away_score !== undefined ? liveMatch.away_score : (away.score || 0);
        const currentHomeScore = liveMatch.home_score !== undefined ? liveMatch.home_score : (home.score || 0);

        scoreOrOddsHtml = `
            <div class="fw-bold text-dark mb-1" style="font-size: 1.2rem; letter-spacing: -0.5px;">
                ${currentAwayScore} - ${currentHomeScore}
            </div>
            <div class="badge bg-light ${badgeColor} border w-100" style="font-size: 0.7rem; border-radius: 12px;">
                ${pulseHtml}${liveMatch.clock}
            </div>`;
    } else {
        scoreOrOddsHtml = `
            <div class="badge bg-light text-dark border w-100 mb-1" style="font-size: 0.75rem;">${data.odds.spread}</div>
            <div class="badge bg-secondary text-white w-100" style="font-size: 0.70rem;">${data.odds.overUnder}</div>`;
    }

    // ==========================================
    // BUILDER 1: STATIC DFS STARTING 5
    // ==========================================
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
    
    const hasAnySlatePlayer = awayBaseStarters.hasValidPlayers || homeBaseStarters.hasValidPlayers || awayBaseBench.hasValidPlayers || homeBaseBench.hasValidPlayers;
    if (selectedSlate !== 'all' && !hasAnySlatePlayer) return null; 

    // ==========================================
    // BUILDER 2: LIVE COURT GRID (Sticky Scroll)
    // ==========================================
    const buildLiveCourtGrid = (teamAbbr, baseStarters, baseBench, liveTeamData) => {
        if (!liveTeamData) return { onCourtHtml: '', benchHtml: '' };
        
        let allPlayers = [];
        const addToAll = (arr) => {
            (arr || []).forEach(p => {
                let name = p.athlete.displayName || p.athlete.fullName;
                allPlayers.push({ name: name, clean: normalizeName(name) });
            });
        };
        addToAll(data.awayStarters === baseStarters ? data.awayStarters : data.homeStarters);
        addToAll(data.awayBench === baseBench ? data.awayBench : data.homeBench);

        // Map live stats and FPTS to players
        allPlayers.forEach(p => {
            let lData = liveTeamData[p.name];
            if (!lData) {
                const matchedKey = Object.keys(liveTeamData).find(k => normalizeName(k) === p.clean);
                if (matchedKey) lData = liveTeamData[matchedKey];
            }
            p.live = lData || { MIN: 0, PTS: 0, REB: 0, AST: 0, STL: 0, BLK: 0, TO: 0, fd_pts: 0, dk_pts: 0, is_on_court: false };
        });

        const fpKey = platform === 'dk' ? 'dk_pts' : 'fd_pts';

        // Sort by "on court" status first, then by FPTS descending to break ties
        allPlayers.sort((a, b) => {
            if (a.live.is_on_court && !b.live.is_on_court) return -1;
            if (!a.live.is_on_court && b.live.is_on_court) return 1;
            return (b.live[fpKey] || 0) - (a.live[fpKey] || 0);
        });

        // Force exactly 5 players onto the court to prevent UI breaking
        let onCourt = allPlayers.slice(0, 5);
        let bench = allPlayers.slice(5);

        // Re-sort bench by FPTS descending
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

        let onCourtHtml = onCourt.map(renderRow).join('');
        let benchHtml = bench.map(renderRow).join('');

        return {
            onCourtHtml: `<div class="overflow-auto live-table-wrapper" id="live-oncourt-${teamAbbr}">${headerHtml}${onCourtHtml}</div>`,
            benchHtml: `<div class="overflow-auto live-table-wrapper" id="live-bench-${teamAbbr}">${benchHeaderHtml}${benchHtml}</div>`
        };
    };

    const awayStd = getStandardAbbr(away.team.abbreviation);
    const homeStd = getStandardAbbr(home.team.abbreviation);
    let awayLiveGrid = { onCourtHtml: '', benchHtml: '' };
    let homeLiveGrid = { onCourtHtml: '', benchHtml: '' };
    
    if (isLiveDataAvailable && liveMatch.players) {
        awayLiveGrid = buildLiveCourtGrid(awayStd, data.awayStarters, data.awayBench, liveMatch.players[awayStd]);
        homeLiveGrid = buildLiveCourtGrid(homeStd, data.homeStarters, data.homeBench, liveMatch.players[homeStd]);
    }

    // ==========================================
    // HTML ASSEMBLY
    // ==========================================
    
    // Missing slate banner
    let missingSlateHtml = '';
    const platKey = platform === 'dk' ? 'draftkings' : 'fanduel';
    if (!hasAnySlatePlayer && selectedSlate === 'all') {
        if (ALL_SLATES[platKey] && ALL_SLATES[platKey].length > 0) {
            missingSlateHtml = `<div class="w-100 text-center py-1 fw-bold text-white bg-secondary border-top" style="font-size: 0.65rem;">🚫 Game not included in ${platform === 'dk' ? 'DK' : 'FD'} slates</div>`;
        } else {
            missingSlateHtml = `<div class="w-100 text-center py-1 fw-bold text-dark border-top" style="font-size: 0.65rem; background-color: #ffecb5;">⏳ ${platform === 'dk' ? 'DK' : 'FD'} salaries & slates pending...</div>`;
        }
    }

    // Team Stats HTML (Dashboard Look - 2 Columns)
    let teamStatsHtml = '';
    if (isLiveDataAvailable) {
        teamStatsHtml = getLiveTeamStatsHtml(away, home, liveMatch);
    }

    // Tabs Header
    let tabsHtml = '';
    if (isLiveDataAvailable) {
        tabsHtml = `
        <div class="d-flex border-top w-100" style="background-color: #f8f9fa;">
            <div class="py-2 flex-fill text-center fw-bold ${cardState.tab === 'starters' ? 'text-dark border-bottom border-dark border-2' : 'text-muted'}" 
                 style="font-size: 0.70rem; cursor: pointer; letter-spacing: 0.5px;" 
                 onclick="toggleGameTab('${localId}', 'starters')">
                 STARTING 5
            </div>
            <div class="py-2 flex-fill text-center fw-bold ${cardState.tab === 'live' ? 'text-success border-bottom border-success border-2' : 'text-muted'}" 
                 style="font-size: 0.70rem; cursor: pointer; letter-spacing: 0.5px;" 
                 onclick="toggleGameTab('${localId}', 'live')">
                 LIVE STATS
            </div>
        </div>`;
    }

    // BASE VIEW (Starters Tab)
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
    const viewStartersHtml = `
        <div id="view-starters-${localId}" class="${cardState.tab === 'live' ? 'd-none' : ''}">
            <div class="row g-0 border-top">
                <div class="col-6 border-end">${awayBaseStarters.html}</div>
                <div class="col-6">${homeBaseStarters.html}</div>
            </div>
            ${baseBenchHtml}
        </div>`;

    // LIVE VIEW (Live Stats Tab)
    let viewLiveHtml = '';
    if (isLiveDataAvailable) {
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
        
        viewLiveHtml = `
            <div id="view-live-${localId}" class="${cardState.tab === 'starters' ? 'd-none' : ''}">
                <div class="row g-0 border-top bg-white">
                    <div class="col-6 border-end w-50 overflow-hidden">${awayLiveGrid.onCourtHtml}</div>
                    <div class="col-6 w-50 overflow-hidden">${homeLiveGrid.onCourtHtml}</div>
                </div>
                ${liveBenchToggleHtml}
            </div>`;
    }

    gameCard.innerHTML = `
        <div class="lineup-card shadow-sm border rounded bg-white overflow-hidden" id="game-${data.localId}">
            <div class="p-2 border-bottom d-flex justify-content-between align-items-center bg-light">
                <div class="d-flex align-items-center">
                    <span class="badge bg-dark text-white" style="font-size: 0.7rem;">${data.gameDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                </div>
                <span class="text-muted fw-bold text-uppercase" style="font-size: 0.6rem;">${data.venue}</span>
            </div>
            <div class="p-2 d-flex align-items-center justify-content-between text-center">
                <div style="width: 35%;"><img src="${away.team.logo}" style="width: 40px;"><div class="fw-bold small mt-1">${away.team.shortDisplayName}</div></div>
                <div style="width: 30%;">${scoreOrOddsHtml}</div>
                <div style="width: 35%;"><img src="${home.team.logo}" style="width: 40px;"><div class="fw-bold small mt-1">${home.team.shortDisplayName}</div></div>
            </div>
            ${missingSlateHtml}
            ${teamStatsHtml}
            ${tabsHtml}
            ${viewStartersHtml}
            ${viewLiveHtml}
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
