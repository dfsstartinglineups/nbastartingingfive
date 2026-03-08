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
