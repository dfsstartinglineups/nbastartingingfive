// ==========================================
// CONFIGURATION
// ==========================================
const DEFAULT_DATE = new Date().toLocaleDateString('en-CA');
let ALL_GAMES_DATA = []; 
let ALL_SLATES = { fanduel: [], draftkings: [] };
let ARE_ALL_EXPANDED = false;

// ==========================================
// 1. MAIN APP LOGIC 
// ==========================================

function normalizeName(name) {
    if (!name) return "";
    
    // 1. Strip all spaces, punctuation, and accents
    let normalized = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z]/g, "").toLowerCase();
    
    // 2. Explicitly map known API mismatches to a single master key
    const nameMap = {
        "ggjackson": "gregoryjackson",
        "ggjacksonii": "gregoryjackson",
        "gregoryjacksonii": "gregoryjackson",
        "pjwashington": "pjwashingtonjr", // Example of another common NBA discrepancy 
        "timhardaway": "timhardawayjr",
        "xaviertillman": "xaviertillmansr",
        "mohamedbamba": "mobamba"
    };
    
    // 3. Return the mapped name if it exists, otherwise return the normalized name
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

async function fetchLocalProbables() {
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
    
    const currentVal = selector.value;
    selector.innerHTML = '<option value="all">All Slates</option>';
    
    // 1. Get the currently viewed date from the date-picker UI
    const datePicker = document.getElementById('date-picker');
    const dateToFetch = datePicker ? datePicker.value : new Date().toLocaleDateString('en-CA');
    
    // 2. Safely parse the date string (YYYY-MM-DD) into a 3-letter day
    const [y, m, d] = dateToFetch.split('-');
    const dateObj = new Date(y, m - 1, d);
    const dayOfWeek = dateObj.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();

    if (ALL_SLATES[platKey] && Array.isArray(ALL_SLATES[platKey])) {
        ALL_SLATES[platKey].forEach(slate => {
            const upperName = slate.name.toUpperCase();
            const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
            
            // Check if the slate explicitly mentions ANY day of the week
            const containsADay = days.some(day => upperName.includes(day));
            
            // 3. THE BOUNCER: Only add the slate if it contains OUR day, or if no day is specified.
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
            fetchLocalProbables()
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
    gameCard.className = 'col-12 col-md-6 col-lg-4 px-1 mb-2';
    
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
            headerHtml = `<div class="text-center py-1 fw-bold border-bottom ${textColor}" style="font-size: 0.6rem; background-color: ${color};">${label}</div>`;
        }
        
        let generatedItemsCount = 0;
        
        const items = players.map((p, index) => {
            const a = p.athlete || p;
            let statsHtml = '';
            let arrowHtml = '';
            
            let rawPos = (a.dfs && a.dfs.pos) ? a.dfs.pos : (a.position ? a.position.abbreviation : 'Flex');
            if (platform === 'dk' && a.dfs && a.dfs.dk_pos) {
                rawPos = a.dfs.dk_pos;
            }
            const displayPos = isBench ? rawPos : (fixedPositions[index] || 'Flex');
            
            let showStats = false;
            let salFmt = '-', projFmt = '-', valFmt = '-';
            let sal = 0;
            
            if (a.dfs) {
                // Determine which slate dictionary to look at based on the platform toggle
                const slatesDict = platform === 'dk' ? (a.dfs.dk_slates || {}) : (a.dfs.fd_slates || {});
                
                // If a specific slate is selected and the player is in it, use the exact slate numbers
                if (selectedSlate !== 'all' && slatesDict[selectedSlate]) {
                    sal = slatesDict[selectedSlate].salary;
                    let proj = slatesDict[selectedSlate].proj;
                    let val = slatesDict[selectedSlate].value;
                    
                    showStats = true;
                    // Format: 3900 -> 3.9k, remove FP, remove x
                    salFmt = sal > 0 ? (sal / 1000).toFixed(1) + 'k' : '-';
                    projFmt = proj > 0 ? proj : '-';
                    valFmt = val > 0 ? val : '-';
                    hasValidPlayersForList = true;
                } 
                // If "All Slates" is selected, fallback to the player's top-level default numbers
                else if (selectedSlate === 'all') {
                    sal = platform === 'dk' ? a.dfs.dk_salary : a.dfs.salary;
                    let proj = platform === 'dk' ? a.dfs.dk_proj : a.dfs.proj;
                    let val = platform === 'dk' ? a.dfs.dk_value : a.dfs.value;
                    
                    if (sal > 0 || proj > 0) {
                        showStats = true;
                        // Format: 3900 -> 3.9k, remove FP, remove x
                        salFmt = sal > 0 ? (sal / 1000).toFixed(1) + 'k' : '-';
                        projFmt = proj > 0 ? proj : '-';
                        valFmt = val > 0 ? val : '-';
                        hasValidPlayersForList = true;
                    }
                }
            }
            
            // Shorten the player's name (e.g., L. James)
            let playerName = a.displayName || a.fullName || 'Unknown';
            if (playerName !== 'Unknown' && playerName.includes(' ')) {
                const parts = playerName.split(' ');
                playerName = `${parts[0][0]}. ${parts.slice(1).join(' ')}`;
            }
            
            if (isBench) {
                if (selectedSlate !== 'all' && !showStats) return '';
                if (selectedSlate === 'all' && sal === 0) return '';
            }
            
            generatedItemsCount++;
            
            // Ultra-compact single-line layout for 3-column grids
            return `
            <li class="px-0 py-1 border-bottom d-flex align-items-center justify-content-between" style="overflow: hidden;">
                <div class="d-flex align-items-center" style="width: 53%; overflow: hidden;">
                    <span class="text-muted fw-bold me-1 text-center" style="font-size: 0.7rem; width: 16px; flex-shrink: 0;">${displayPos}</span>
                    <span class="text-truncate" style="font-size: 0.75rem;" title="${a.displayName || a.fullName}">${playerName}</span>
                </div>
                ${showStats ? `
                <div class="d-flex align-items-center justify-content-end fw-bold text-muted" style="width: 47%; font-size: 0.7rem; letter-spacing: -0.4px;">
                    <span style="width: 32%; text-align: right;">${salFmt}</span>
                    <span style="width: 36%; text-align: center;">${projFmt}</span>
                    <span style="width: 32%; text-align: left;">${valFmt}</span>
                </div>
                ` : `<div style="width: 47%;"></div>`}
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
    
    if (selectedSlate !== 'all') {
        const hasAnySlatePlayer = awayStartersInfo.hasValidPlayers || homeStartersInfo.hasValidPlayers || awayBenchInfo.hasValidPlayers || homeBenchInfo.hasValidPlayers;
        if (!hasAnySlatePlayer) {
            return null; // Prevents the card from being rendered
        }
    }

    let benchRibbonHtml = '';
    if (awayBenchInfo.html || homeBenchInfo.html) {
        benchRibbonHtml = `
            <div class="border-top bg-light">
                <div class="p-2 text-center border-bottom text-muted fw-bold bench-toggle" onclick="toggleBench(this)" style="font-size: 0.70rem; cursor: pointer; background-color: #f8f9fa; transition: background-color 0.2s;">
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

window.generateTweet = function(team, opp, starters, odds, gameDate, gameId, isProjected) {
    if (isProjected) {
        alert("Cannot share unverified lineups. Wait for ✅ OFFICIAL status.");
        return;
    }
    
    let oddsStr = odds.spread !== "TBD" ? `Odds: ${odds.spread} | ${odds.overUnder}` : "Odds: TBD";
    let tweetText = `🏀 ${gameDate} ${team} Starting Lineup vs ${opp}\n${oddsStr}\n\n`;
    
    const fixedPositions = ['PG', 'SG', 'SF', 'PF', 'C'];
    starters.forEach((p, i) => {
        const a = p.athlete || p;
        const name = a.displayName || a.fullName || 'Unknown';
        tweetText += `${fixedPositions[i] || 'Flex'} ${name}\n`;
    });
    
    const teamHash = team.replace(/\s+/g, '');
    tweetText += `\n\nFull matchups & odds: https://nbastartingfive.com/#game-${gameId}\n\n#${teamHash} #${teamHash}Lineup #NBA #DFS #StartingFive`;
    
    document.getElementById('tweet-textarea').value = tweetText;
    
    const copyBtn = document.getElementById('copy-tweet-btn');
    copyBtn.innerHTML = '📋 Copy to Clipboard';
    copyBtn.classList.remove('btn-success');
    copyBtn.classList.add('btn-dark');
    
    const modal = new bootstrap.Modal(document.getElementById('tweetModal'));
    modal.show();
};

document.getElementById('copy-tweet-btn')?.addEventListener('click', function() {
    const text = document.getElementById('tweet-textarea').value;
    navigator.clipboard.writeText(text).then(() => {
        this.innerHTML = '✅ Copied!';
        this.classList.remove('btn-dark');
        this.classList.add('btn-success');
    });
});

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

    // Mobile Search Toggle
    const searchToggleBtn = document.getElementById('search-toggle-btn');
    const teamSearchInput = document.getElementById('team-search');
    
    if (searchToggleBtn && teamSearchInput) {
        searchToggleBtn.addEventListener('click', () => {
            teamSearchInput.classList.toggle('expanded');
            if (teamSearchInput.classList.contains('expanded')) {
                teamSearchInput.focus();
            }
        });
        
        // Auto-collapse search when clicking somewhere else on the screen (Mobile only)
        document.addEventListener('click', (e) => {
            if (window.innerWidth < 768 && teamSearchInput.classList.contains('expanded')) {
                if (!teamSearchInput.contains(e.target) && !searchToggleBtn.contains(e.target)) {
                    teamSearchInput.classList.remove('expanded');
                }
            }
        });
    }
    
    
    
});
