// ==========================================
// CONFIGURATION
// ==========================================
const DEFAULT_DATE = new Date().toLocaleDateString('en-CA');
let ALL_GAMES_DATA = []; 
let ALL_SLATES = { fanduel: [], draftkings: [] };
let ARE_ALL_EXPANDED = false; // Controls global expand/collapse state

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

async function fetchLocalData() {
    try {
        const response = await fetch('nba_data.json?v=' + new Date().getTime());
        if (response.ok) {
            return await response.json();
        }
    } catch (e) {
        console.log("No local nba_data.json found.");
    }
    return { games: [], slates: { fanduel: [], draftkings: [] } };
}

// ==========================================
// 2. TOGGLE LOGIC (Player, Card, Bench, Global)
// ==========================================

window.togglePlayerStats = function(element) {
    const li = element.closest('li');
    const statsRow = li.querySelector('.player-stats-row');
    const icon = li.querySelector('.stats-toggle-icon');
    
    if (!statsRow) return; 
    
    if (statsRow.classList.contains('d-none')) {
        statsRow.classList.remove('d-none');
        statsRow.classList.add('d-flex');
        if (icon) icon.innerHTML = '▼';
    } else {
        statsRow.classList.add('d-none');
        statsRow.classList.remove('d-flex');
        if (icon) icon.innerHTML = '▶';
    }
};

window.toggleCardStats = function(btn) {
    const card = btn.closest('.lineup-card');
    const isExpanding = btn.innerHTML.includes('+');
    btn.innerHTML = isExpanding ? '[-] Stats' : '[+] Stats';
    
    card.querySelectorAll('.player-stats-row').forEach(row => {
        if (isExpanding) {
            row.classList.remove('d-none');
            row.classList.add('d-flex');
        } else {
            row.classList.add('d-none');
            row.classList.remove('d-flex');
        }
    });
    
    card.querySelectorAll('.stats-toggle-icon').forEach(icon => {
        icon.innerHTML = isExpanding ? '▼' : '▶';
    });
};

window.toggleBench = function(el) {
    const container = el.nextElementSibling;
    const arrow = el.querySelector('.bench-arrow');
    if (container.style.display === 'none') {
        container.style.display = 'flex';
        arrow.innerHTML = '▲';
    } else {
        container.style.display = 'none';
        arrow.innerHTML = '▼';
    }
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
    
    selector.innerHTML = '<option value="all">All Slates</option>';
    
    if (ALL_SLATES[platKey] && Array.isArray(ALL_SLATES[platKey])) {
        ALL_SLATES[platKey].forEach(slate => {
            const opt = document.createElement('option');
            opt.value = slate.id;
            opt.textContent = slate.name;
            selector.appendChild(opt);
        });
    }
    
    selector.value = 'all';
}

function handleHashNavigation() {
    if (window.location.hash) {
        setTimeout(() => {
            const targetId = window.location.hash.substring(1);
            const targetCard = document.getElementById(targetId);
            
            if (targetCard) {
                targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
                const innerHeader = targetCard.querySelector('.bg-light'); 
                
                targetCard.style.transition = 'all 0.4s ease-out';
                targetCard.style.transform = 'scale(1.02)';
                targetCard.style.setProperty('border', '3px solid #dc3545', 'important');
                targetCard.style.setProperty('box-shadow', '0 0 25px rgba(220, 53, 69, 0.8)', 'important');
                targetCard.style.position = 'relative'; 
                targetCard.style.zIndex = '10';
                
                if (innerHeader) {
                    innerHeader.classList.remove('bg-light');
                    innerHeader.style.transition = 'background-color 0.4s ease-out';
                    innerHeader.style.backgroundColor = '#f8d7da'; 
                }
                
                setTimeout(() => {
                    targetCard.style.transform = 'scale(1)';
                    targetCard.style.removeProperty('border'); 
                    targetCard.style.setProperty('box-shadow', '0 2px 4px rgba(0,0,0,0.05)', 'important');
                    targetCard.style.zIndex = '1';
                    
                    if (innerHeader) {
                        innerHeader.style.backgroundColor = '';
                        innerHeader.classList.add('bg-light');
                    }
                }, 4000); 
            }
        }, 600); 
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
        const [scheduleResponse, localData] = await Promise.all([
            fetch(ESPN_API_URL),
            fetchLocalData()
        ]);
        const scheduleData = await scheduleResponse.json();
        
        const localProbables = localData.games || [];
        ALL_SLATES = localData.slates || { fanduel: [], draftkings: [] };
        
        populateSlates();

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

            // Extract Away Starters and Bench
            let awayStarters = [], awayIsProjected = true, awayBench = [];
            let localAwayPlayers = (localGameMatch && localGameMatch.rosters && localGameMatch.rosters[awayStd]) ? localGameMatch.rosters[awayStd].players : null;
            let localAwayBench = (localGameMatch && localGameMatch.rosters && localGameMatch.rosters[awayStd]) ? localGameMatch.rosters[awayStd].bench : [];
            
            if (localAwayPlayers && localAwayPlayers.every(p => p.verified)) {
                awayStarters = localAwayPlayers.map(p => ({ athlete: { displayName: p.name, position: { abbreviation: p.pos }, dfs: p } }));
                awayIsProjected = false;
            } else if (awayTeamData.starters) {
                awayStarters = awayTeamData.starters; awayIsProjected = false;
            } else if (localAwayPlayers) {
                awayStarters = localAwayPlayers.map(p => ({ athlete: { displayName: p.name, position: { abbreviation: p.pos }, dfs: p } }));
            }
            if (localAwayBench) awayBench = localAwayBench.map(p => ({ athlete: { displayName: p.name, position: { abbreviation: p.pos }, dfs: p } }));

            // Extract Home Starters and Bench
            let homeStarters = [], homeIsProjected = true, homeBench = [];
            let localHomePlayers = (localGameMatch && localGameMatch.rosters && localGameMatch.rosters[homeStd]) ? localGameMatch.rosters[homeStd].players : null;
            let localHomeBench = (localGameMatch && localGameMatch.rosters && localGameMatch.rosters[homeStd]) ? localGameMatch.rosters[homeStd].bench : [];
            
            if (localHomePlayers && localHomePlayers.every(p => p.verified)) {
                homeStarters = localHomePlayers.map(p => ({ athlete: { displayName: p.name, position: { abbreviation: p.pos }, dfs: p } }));
                homeIsProjected = false;
            } else if (homeTeamData.starters) {
                homeStarters = homeTeamData.starters; homeIsProjected = false;
            } else if (localHomePlayers) {
                homeStarters = localHomePlayers.map(p => ({ athlete: { displayName: p.name, position: { abbreviation: p.pos }, dfs: p } }));
            }
            if (localHomeBench) homeBench = localHomeBench.map(p => ({ athlete: { displayName: p.name, position: { abbreviation: p.pos }, dfs: p } }));

            // Fix Positions for Starters
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
                homeBench, awayBench,
                odds, venue: comp.venue?.fullName || "TBD",
                gameDate: new Date(game.date), status: game.status.type.detail,
                localId: localId
            });
        });
        
        renderGames();
        handleHashNavigation();
        
    } catch (error) {
        console.error("Init error:", error);
        if (container) container.innerHTML = `<div class="col-12 text-center mt-5"><div class="alert alert-danger">Failed to load schedule.</div></div>`;
    }
}

function renderGames() {
    const container = document.getElementById('games-container');
    if (!container) return;
    container.innerHTML = '';
    const searchText = document.getElementById('team-search')?.value.toLowerCase() || '';
    
    ALL_GAMES_DATA.filter(item => (item.away.team.displayName + " " + item.home.team.displayName).toLowerCase().includes(searchText))
        .sort((a, b) => a.gameDate - b.gameDate)
        .forEach(item => {
            const card = createGameCard(item);
            if (card) container.appendChild(card);
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

    const buildLineupList = (players, isProjected, isBench = false) => {
        if (!players || !players.length) {
            if (isBench) return { html: '', hasValidPlayers: false };
            return { html: `<div class="p-4 text-center text-muted small fw-bold">Lineup pending...</div>`, hasValidPlayers: false };
        }
        
        const platformNode = document.querySelector('input[name="dfsPlatform"]:checked');
        const platform = platformNode ? platformNode.value : 'fd';
        const slateSelector = document.getElementById('slate-selector');
        const selectedSlate = slateSelector ? slateSelector.value : 'all';
        
        const fixedPositions = ['PG', 'SG', 'SF', 'PF', 'C'];
        let hasValidPlayersForList = false;
        
        let headerHtml = '';
        if (!isBench) {
            const color = isProjected ? "#ffecb5" : "#198754";
            const textColor = isProjected ? "text-dark" : "text-white";
            const label = isProjected ? "⚠️ PROJECTED" : "✅ OFFICIAL";
            headerHtml = `<div class="text-center py-1 fw-bold ${textColor}" style="font-size: 0.6rem; background-color: ${color};">${label}</div>`;
        }
        
        let generatedItemsCount = 0;
        
        const items = players.map((p, index) => {
            const a = p.athlete || p;
            let statsHtml = '';
            let arrowHtml = '';
            
            // Extract the correct position layout depending if they are a starter or bench
            let rawPos = (a.dfs && a.dfs.pos) ? a.dfs.pos : (a.position ? a.position.abbreviation : 'Flex');
            if (platform === 'dk' && a.dfs && a.dfs.dk_pos) {
                rawPos = a.dfs.dk_pos;
            }
            const displayPos = isBench ? rawPos : (fixedPositions[index] || 'Flex');
            
            let showStats = false;
            let salFmt = '-', projFmt = '-', valFmt = '-';
            let sal = 0;
            
            if (a.dfs) {
                sal = platform === 'dk' ? a.dfs.dk_salary : a.dfs.salary;
                const proj = platform === 'dk' ? a.dfs.dk_proj : a.dfs.proj;
                const val = platform === 'dk' ? a.dfs.dk_value : a.dfs.value;
                const slates = platform === 'dk' ? (a.dfs.dk_slates || []) : (a.dfs.fd_slates || []);
                
                if (sal > 0 || proj > 0) {
                    if (selectedSlate === 'all' || slates.includes(selectedSlate)) {
                        showStats = true;
                        salFmt = sal > 0 ? `$${sal}` : '-';
                        projFmt = proj > 0 ? `${proj} FP` : '-';
                        valFmt = val > 0 ? `${val}x` : '-';
                        hasValidPlayersForList = true;
                    }
                }
            }
            
            const playerName = a.displayName || a.fullName || 'Unknown';
            
            if (isBench) {
                // If they are on the bench and not in the selected slate, hide them.
                if (selectedSlate !== 'all' && !showStats) return '';
                // If viewing all slates, only show bench players who have a salary on the selected platform.
                if (selectedSlate === 'all' && sal === 0) return '';
            }
            
            generatedItemsCount++;
            
            if (showStats) {
                const displayState = ARE_ALL_EXPANDED ? 'd-flex' : 'd-none';
                statsHtml = `
                <div class="w-100 mt-1 dfs-stats player-stats-row ${displayState}" style="font-size: 0.65rem; color: #6c757d; border-top: 1px dashed rgba(0,0,0,0.05); padding-top: 2px;">
                    <div class="text-start fw-bold" style="flex: 1;">${salFmt}</div>
                    <div class="text-center fw-bold border-start border-end" style="flex: 1; border-color: rgba(0,0,0,0.05) !important;">${projFmt}</div>
                    <div class="text-end fw-bold" style="flex: 1;">${valFmt}</div>
                </div>`;
                arrowHtml = `<span class="ms-auto stats-toggle-icon" style="font-size: 0.6rem; color: #adb5bd;">${ARE_ALL_EXPANDED ? '▼' : '▶'}</span>`;
            }
            
            return `
            <li class="px-1 py-1 border-bottom d-flex flex-column align-items-start" style="overflow: hidden;">
                <div class="d-flex w-100 justify-content-start align-items-center" ${showStats ? 'onclick="togglePlayerStats(this)" style="cursor: pointer;"' : ''}>
                    <span class="text-muted fw-bold me-1 text-center" style="font-size: 0.75rem; width: 18px; display: inline-block;">${displayPos}</span>
                    <span class="fw-bold text-truncate" style="font-size: 0.85rem; max-width: 75%;">${playerName}</span>
                    ${arrowHtml}
                </div>
                ${statsHtml}
            </li>`;
        }).join('');
        
        if (isBench && generatedItemsCount === 0) {
            return { html: '', hasValidPlayers: false };
        }
        
        return { html: `${headerHtml}<ul class="list-unstyled m-0">${items}</ul>`, hasValidPlayers: hasValidPlayersForList };
    };

    const awayStartersInfo = buildLineupList(data.awayStarters, data.awayIsProjected, false);
    const homeStartersInfo = buildLineupList(data.homeStarters, data.homeIsProjected, false);
    const awayBenchInfo = buildLineupList(data.awayBench, false, true);
    const homeBenchInfo = buildLineupList(data.homeBench, false, true);
    
    const slateSelector = document.getElementById('slate-selector');
    const selectedSlate = slateSelector ? slateSelector.value : 'all';
    
    // Auto-hide the game completely if NO players match the selected slate
    if (selectedSlate !== 'all') {
        const hasAnySlatePlayer = awayStartersInfo.hasValidPlayers || homeStartersInfo.hasValidPlayers || awayBenchInfo.hasValidPlayers || homeBenchInfo.hasValidPlayers;
        if (!hasAnySlatePlayer) {
            gameCard.classList.add('d-none');
            return gameCard;
        }
    }

    let benchRibbonHtml = '';
    if (awayBenchInfo.html || homeBenchInfo.html) {
        benchRibbonHtml = `
            <div class="border-top bg-light">
                <div class="p-2 text-center border-bottom text-muted fw-bold bench-toggle" onclick="toggleBench(this)" style="font-size: 0.75rem; cursor: pointer; background-color: #f8f9fa;">
                    <span>View Bench Options</span> <span class="bench-arrow ms-1">▼</span>
                </div>
                <div class="row g-0 bench-container" style="display: none;">
                    <div class="col-6 border-end">${awayBenchInfo.html}</div>
                    <div class="col-6">${homeBenchInfo.html}</div>
                </div>
            </div>
        `;
    }

    gameCard.innerHTML = `
        <div class="lineup-card shadow-sm border rounded bg-white overflow-hidden" id="game-${data.localId}">
            <div class="p-2 border-bottom d-flex justify-content-between align-items-center bg-light">
                <div class="d-flex align-items-center">
                    <span class="badge bg-dark text-white" style="font-size: 0.7rem;">${data.gameDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                    <button class="btn btn-sm btn-link text-decoration-none card-toggle-btn p-0 ms-2 fw-bold" style="font-size: 0.65rem; color: #6c757d;" onclick="toggleCardStats(this)">${ARE_ALL_EXPANDED ? '[-] Stats' : '[+] Stats'}</button>
                </div>
                <span class="text-muted fw-bold text-uppercase" style="font-size: 0.6rem;">${data.venue}</span>
            </div>
            <div class="p-2 d-flex align-items-center justify-content-between text-center">
                <div style="width: 35%;"><img src="${away.team.logo}" style="width: 40px;"><div class="fw-bold small">${away.team.shortDisplayName}</div></div>
                <div style="width: 30%;">${scoreOrOddsHtml}</div>
                <div style="width: 35%;"><img src="${home.team.logo}" style="width: 40px;"><div class="fw-bold small">${home.team.shortDisplayName}</div></div>
            </div>
            <div class="row g-0 border-top">
                <div class="col-6 border-end">${awayStartersInfo.html}</div>
                <div class="col-6">${homeStartersInfo.html}</div>
            </div>
            ${benchRibbonHtml}
        </div>`;
        
    return gameCard;
}

document.addEventListener('DOMContentLoaded', () => {
    init(DEFAULT_DATE);
    
    document.getElementById('team-search')?.addEventListener('input', renderGames);
    document.getElementById('date-picker')?.addEventListener('change', (e) => {
        init(e.target.value);
        e.target.blur();
    });
    
    // Auto-update UI when DFS platform is toggled
    document.querySelectorAll('.dfs-toggle').forEach(radio => radio.addEventListener('change', () => {
        populateSlates();
        renderGames();
    }));
    
    // Re-render games when slate dropdown changes
    document.getElementById('slate-selector')?.addEventListener('change', renderGames);
    
    // Global Expand/Collapse Button
    const globalToggleBtn = document.getElementById('global-toggle-btn');
    if (globalToggleBtn) {
        globalToggleBtn.addEventListener('click', (e) => {
            ARE_ALL_EXPANDED = !ARE_ALL_EXPANDED;
            e.target.innerHTML = ARE_ALL_EXPANDED ? '[-] Collapse All' : '[+] Expand All';
            
            document.querySelectorAll('.player-stats-row').forEach(row => {
                if (ARE_ALL_EXPANDED) {
                    row.classList.remove('d-none');
                    row.classList.add('d-flex');
                } else {
                    row.classList.add('d-none');
                    row.classList.remove('d-flex');
                }
            });
            document.querySelectorAll('.stats-toggle-icon').forEach(icon => {
                icon.innerHTML = ARE_ALL_EXPANDED ? '▼' : '▶';
            });
            document.querySelectorAll('.card-toggle-btn').forEach(btn => {
                btn.innerHTML = ARE_ALL_EXPANDED ? '[-] Stats' : '[+] Stats';
            });
        });
    }
});
