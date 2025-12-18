import pandas as pd
import json
import glob
import os
import datetime
import requests
import sys
import re
from datetime import datetime as dt

# --- CONFIGURATION ---
BBM_URL = "https://basketballmonster.com/nbalineups.aspx"

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
}

# STANDARD TEAM CODES (Map everything to ESPN/Standard 3-letter code)
TEAM_MAP = {
    'GS': 'GSW', 'GOLDEN STATE': 'GSW', 'GSW': 'GSW',
    'NO': 'NOP', 'NEW ORLEANS': 'NOP', 'NOP': 'NOP', 'NOH': 'NOP',
    'NY': 'NYK', 'NEW YORK': 'NYK', 'NYK': 'NYK',
    'SA': 'SAS', 'SAN ANTONIO': 'SAS', 'SAS': 'SAS',
    'PHO': 'PHX', 'PHOENIX': 'PHX', 'PHX': 'PHX',
    'UT': 'UTA', 'UTAH': 'UTA', 'UTA': 'UTA',
    'WSH': 'WAS', 'WASHINGTON': 'WAS', 'WAS': 'WAS',
    'BKO': 'BKN', 'BROOKLYN': 'BKN', 'BKN': 'BKN',
    'CHO': 'CHA', 'CHA': 'CHA', 'CHARLOTTE': 'CHA'
}

# NAME MAPPING (Fixes "Cam" vs "Cameron", etc.)
NICKNAMES = {
    'cam': 'cameron',
    'nic': 'nicolas',
    'patti': 'patrick',
    'pat': 'patrick',
    'mo': 'moritz',
    'moe': 'moritz',
    'zach': 'zachary',
    'tim': 'timothy',
    'gucci': 'santi', # rare nickname edge cases
    'kj': 'kenyon',
    'x': 'xavier',
    'herb': 'herbert',
    'bub': 'carrinton'
}

def normalize_team(team_name):
    if pd.isna(team_name): return ""
    clean_name = str(team_name).strip().upper()
    return TEAM_MAP.get(clean_name, clean_name)

def clean_player_name(name):
    """Normalizes player names for matching."""
    if not name or name == '-': return None
    
    # Lowercase and strip
    name = name.lower().strip()
    
    # Remove common suffixes and punctuation
    name = name.replace('.', '').replace("'", "")
    for suffix in [' jr', ' sr', ' ii', ' iii', ' iv']:
        if name.endswith(suffix):
            name = name[:-len(suffix)]
    
    # Remove injury tags if they snuck in
    tags = [' q', ' out', ' in', ' gtd', ' p', ' probable', ' questionable', ' doubtful']
    for tag in tags:
        if name.endswith(tag):
            name = name[:-len(tag)]
            
    # Handle Nicknames (First name only)
    parts = name.split()
    if parts and parts[0] in NICKNAMES:
        parts[0] = NICKNAMES[parts[0]]
    
    return " ".join(parts)

def parse_time_to_minutes(time_str):
    """Converts '7:00 PM' to minutes from midnight for sorting."""
    try:
        # Assume ET. Format is usually "7:00 pm"
        t = dt.strptime(time_str.strip(), "%I:%M %p")
        return t.hour * 60 + t.minute
    except:
        return 9999 # Put at end if parse fails

def get_data_from_basketball_monster():
    print(f"Fetching from {BBM_URL}...")
    
    starters = {}      # { 'NOP': ['player1', 'player2'] }
    game_times = {}    # { 'NOP': '7:00 PM' }
    
    try:
        response = requests.get(BBM_URL, headers=HEADERS, timeout=10)
        # Simple parsing without BS4 dependency if possible, but regex is brittle.
        # We will stick to simple string splits for robustness on minimal envs,
        # or just use simple text finding if BS4 fails.
        # Assuming BS4 is installed as per previous instructions.
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(response.text, 'html.parser')
        
        rows = soup.find_all('tr')
        
        current_time = "TBD"
        
        for row in rows:
            cols = [c.get_text(strip=True) for c in row.find_all(['td', 'th'])]
            if not cols: continue
            
            # --- HEADER ROW DETECTION ---
            # Look for the row with the "@" symbol between teams
            # Format often: [Time, Away, @Home] or [Away, @Home]
            
            # Check for Time in col 0
            # Regex for time like "7:00 pm"
            if len(cols) >= 3 and ("@" in cols[2] or "@" in cols[1]):
                
                # Try to grab time from first col
                potential_time = cols[0]
                if ':' in potential_time and ('am' in potential_time.lower() or 'pm' in potential_time.lower()):
                    current_time = potential_time
                
                raw_away = cols[1].replace('@', '').strip()
                raw_home = cols[2].replace('@', '').strip()
                
                team_away = normalize_team(raw_away)
                team_home = normalize_team(raw_home)
                
                # Initialize
                if team_away not in starters: starters[team_away] = []
                if team_home not in starters: starters[team_home] = []
                
                game_times[team_away] = current_time
                game_times[team_home] = current_time
                continue
                
            # --- PLAYER ROW DETECTION ---
            if len(cols) >= 3 and cols[0] in ['PG', 'SG', 'SF', 'PF', 'C']:
                # We need to know the active teams.
                # Since BBM lists games sequentially, we need to track the "most recent" teams found.
                # This is tricky with a flat loop. 
                # Better approach: The previous block set the keys in `starters` (dictionary is insertion-ordered in Python 3.7+)
                # We can grab the last two keys added.
                if not starters: continue
                
                active_teams = list(starters.keys())[-2:] # Get last 2 teams added
                tm_away = active_teams[0]
                tm_home = active_teams[1]
                
                p_away = clean_player_name(cols[1])
                p_home = clean_player_name(cols[2])
                
                if p_away and p_away != '-': starters[tm_away].append(p_away)
                if p_home and p_home != '-': starters[tm_home].append(p_home)

    except Exception as e:
        print(f"Error parsing BBM: {e}")
        
    return starters, game_times

def build_json():
    print("--- Starting NBA Data Build ---")

    # 1. FIND FILES
    dff_files = glob.glob('*DFF*.csv')
    fd_files = glob.glob('*FanDuel*.csv')
    
    if not dff_files or not fd_files:
        print("ERROR: MISSING CSV FILES")
        sys.exit(1)

    dff_path = sorted(dff_files)[-1]
    fd_path = sorted(fd_files)[-1]

    # 2. LOAD FILES
    try:
        dff_df = pd.read_csv(dff_path)
        fd_df = pd.read_csv(fd_path)
    except Exception as e:
        print(f"Error reading CSVs: {e}")
        sys.exit(1)

    # 3. NORMALIZE TEAMS
    dff_df['team'] = dff_df['team'].apply(normalize_team)
    dff_df['opp'] = dff_df['opp'].apply(normalize_team)
    fd_df['Team'] = fd_df['Team'].apply(normalize_team)

    # 4. NORMALIZE NAMES FOR MERGE
    dff_df['norm_first'] = dff_df['first_name'].str.lower().str.strip()
    dff_df['norm_last'] = dff_df['last_name'].str.lower().str.strip()
    dff_df['norm_team'] = dff_df['team'].str.strip()
    
    fd_df['norm_first'] = fd_df['First Name'].str.lower().str.strip()
    fd_df['norm_last'] = fd_df['Last Name'].str.lower().str.strip()
    fd_df['norm_team'] = fd_df['Team'].str.strip()
    
    # 5. MERGE
    merged_df = pd.merge(dff_df, fd_df, 
        left_on=['norm_first', 'norm_last', 'norm_team'],
        right_on=['norm_first', 'norm_last', 'norm_team'],
        how='inner'
    )
    merged_df = merged_df.drop_duplicates(subset=['norm_first', 'norm_last', 'norm_team'])
    
    # Create a Clean Name column for matching
    merged_df['Clean_Name'] = merged_df.apply(
        lambda x: clean_player_name(f"{x['first_name']} {x['last_name']}"), axis=1
    )

    # 6. GET WEB DATA
    web_starters, web_times = get_data_from_basketball_monster()
    
    # 7. MATCH PLAYERS
    merged_df['Is_Starter'] = False
    
    unique_teams = merged_df['team'].unique()
    
    for team in unique_teams:
        if team not in web_starters: continue
        
        starters_list = web_starters[team] # These are already cleaned names
        if not starters_list: continue
        
        # Check for matches
        # We check if the csv 'Clean_Name' is IN the list of web starters
        mask = merged_df['Clean_Name'].isin(starters_list)
        
        # Also try partial match (e.g. web says "Cam Johnson", csv says "Cameron Johnson")
        # The clean_player_name function handles most of this, but let's be double sure
        for web_p in starters_list:
            # If we didn't match it exactly yet
            if not mask.any():
                # Fuzzy fallback (contains)
                fuzzy_mask = (merged_df['team'] == team) & (merged_df['Clean_Name'].str.contains(web_p, regex=False))
                if fuzzy_mask.any():
                    merged_df.loc[fuzzy_mask.index, 'Is_Starter'] = True
        
        # Apply exact matches
        matches = merged_df[(merged_df['team'] == team) & (merged_df['Clean_Name'].isin(starters_list))]
        if not matches.empty:
            merged_df.loc[matches.index, 'Is_Starter'] = True

    # 8. BUILD JSON
    # Eastern Time Calculation
    utc_now = datetime.datetime.utcnow()
    et_now = utc_now - timedelta(hours=5)
    formatted_time = et_now.strftime("%b %d, %I:%M %p ET")

    data_export = {
        "last_updated": formatted_time,
        "games": []
    }

    def position_rank(pos_str):
        if not isinstance(pos_str, str): return 99
        primary_pos = pos_str.split('/')[0]
        order = {'PG': 1, 'SG': 2, 'SF': 3, 'PF': 4, 'C': 5}
        return order.get(primary_pos, 99)
    
    merged_df['Pos_Rank'] = merged_df['position'].apply(position_rank)
    logo_base = "https://a.espncdn.com/i/teamlogos/nba/500/"
    meta_lookup = dff_df[['team', 'opp', 'spread', 'over_under']].drop_duplicates().set_index('team').to_dict('index')
    
    processed_teams = set()
    
    # PREPARE GAME OBJECTS
    games_list = []
    
    for team in unique_teams:
        if team in processed_teams: continue
        team_row = merged_df[merged_df['team'] == team]
        if team_row.empty: continue
        opp = normalize_team(team_row.iloc[0]['opp'])
        
        processed_teams.add(team)
        processed_teams.add(opp)
        
        meta = meta_lookup.get(team, {})
        spread = meta.get('spread', 0)
        spread_str = f"{spread}" if spread < 0 else f"+{spread}"
        
        # Get Time from Web Data or Default
        game_time_str = web_times.get(team, "7:00 PM")
        sort_val = parse_time_to_minutes(game_time_str)
        
        game_obj = {
            "id": f"{team}-{opp}",
            "sort_index": sort_val, # Internal use for sorting
            "teams": [team, opp],
            "meta": {
                "spread": spread_str,
                "total": str(meta.get('over_under', 'TBD')),
                "time": game_time_str
            },
            "rosters": {}
        }
        
        for current_team in [team, opp]:
            starters_df = merged_df[
                (merged_df['team'] == current_team) & 
                (merged_df['Is_Starter'] == True)
            ].sort_values('Pos_Rank')
            
            player_list = []
            
            # CHECK: Only show if we found roughly 5 players (or at least >0)
            # If 0 found, it means we don't know the lineup yet.
            if not starters_df.empty:
                for _, p in starters_df.iterrows():
                    val = p['ppg_projection'] / (p['salary']/1000) if p['salary'] > 0 else 0
                    inj = str(p['injury_status']) if pd.notna(p['injury_status']) and str(p['injury_status']) != 'nan' else ""
                    
                    player_list.append({
                        "pos": p['position'],
                        "name": f"{p['first_name']} {p['last_name']}",
                        "salary": int(p['salary']),
                        "proj": round(p['ppg_projection'], 1),
                        "value": round(val, 2),
                        "injury": inj
                    })
            else:
                 player_list.append({
                    "pos": "-", "name": "Waiting for Lineup",
                    "salary": 0, "proj": 0, "value": 0, "injury": ""
                })

            game_obj['rosters'][current_team] = {
                "logo": f"{logo_base}{current_team.lower()}.png",
                "players": player_list
            }
            
        games_list.append(game_obj)
    
    # SORT GAMES BY TIME
    games_list.sort(key=lambda x: x['sort_index'])
    
    # Clean up sort_index before saving
    for g in games_list:
        del g['sort_index']
        
    data_export['games'] = games_list
        
    with open('nba_data.json', 'w') as f:
        json.dump(data_export, f, indent=2)
    print("SUCCESS: nba_data.json updated.")

if __name__ == "__main__":
    build_json()
