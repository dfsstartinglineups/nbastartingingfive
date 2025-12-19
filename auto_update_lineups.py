import pandas as pd
import json
import glob
import os
import requests
import re
from datetime import datetime, timedelta

# --- CONFIGURATION ---
# We use the specific Lineups URL because it contains the <a> tags we need
BBM_URL = "https://basketballmonster.com/nbalineups.aspx"

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
}

# STANDARD TEAM CODES (Map BBM/CSV codes to a standard 3-letter Key)
TEAM_MAP = {
    'GS': 'GSW', 'GOLDEN STATE': 'GSW', 'GSW': 'GSW',
    'NO': 'NOP', 'NEW ORLEANS': 'NOP', 'NOP': 'NOP', 'NOH': 'NOP', 'PELICANS': 'NOP', 'NOR': 'NOP',
    'NY': 'NYK', 'NEW YORK': 'NYK', 'NYK': 'NYK', 'KNICKS': 'NYK',
    'SA': 'SAS', 'SAN ANTONIO': 'SAS', 'SAS': 'SAS', 'SPURS': 'SAS',
    'PHO': 'PHX', 'PHOENIX': 'PHX', 'PHX': 'PHX',
    'UT': 'UTA', 'UTAH': 'UTA', 'UTA': 'UTA', 'JAZZ': 'UTA',
    'WSH': 'WAS', 'WASHINGTON': 'WAS', 'WAS': 'WAS',
    'BKO': 'BKN', 'BROOKLYN': 'BKN', 'BKN': 'BKN',
    'CHO': 'CHA', 'CHA': 'CHA', 'CHARLOTTE': 'CHA'
}

# NICKNAME MAP (Helps CSV matching)
NICKNAMES = {
    'cam': 'cameron', 'nic': 'nicolas', 'patti': 'patrick', 'pat': 'patrick',
    'mo': 'moritz', 'moe': 'moritz', 'zach': 'zachary', 'tim': 'timothy',
    'kj': 'kenyon', 'x': 'xavier', 'herb': 'herbert', 'bub': 'carrinton',
    'greg': 'gregory', 'nick': 'nicholas', 'mitch': 'mitchell', 'kelly': 'kelly',
    'pj': 'pj', 'trey': 'trey', 'cj': 'cj', 'c.j.': 'cj', 'shai': 'shai'
}

def normalize_team(team_name):
    if pd.isna(team_name): return ""
    clean_name = str(team_name).strip().upper()
    return TEAM_MAP.get(clean_name, clean_name)

def clean_player_name(name):
    if not name or name == '-': return None
    name = str(name).lower().strip()
    name = name.replace('.', '').replace("'", "")
    for suffix in [' jr', ' sr', ' ii', ' iii', ' iv']:
        if name.endswith(suffix):
            name = name[:-len(suffix)]
    
    parts = name.split()
    if parts and parts[0] in NICKNAMES:
        parts[0] = NICKNAMES[parts[0]]
    
    return " ".join(parts)

def parse_time_to_minutes(time_str):
    try:
        t = datetime.strptime(time_str.strip().upper(), "%I:%M %p")
        return t.hour * 60 + t.minute
    except:
        return 9999

# --- STEP 1: SCRAPE BASKETBALL MONSTER ---
def scrape_starters():
    print(f"--- SCRAPING {BBM_URL} ---")
    
    try:
        response = requests.get(BBM_URL, headers=HEADERS, timeout=15)
        # Simple text parsing to avoid BS4 dependency issues if any, 
        # but BS4 is safer for specific tag attributes.
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(response.text, 'html.parser')
        rows = soup.find_all('tr')
    except Exception as e:
        print(f"CRITICAL ERROR SCRAPING: {e}")
        return {}, {}

    starters_map = {} # { 'LAL': ['LeBron', 'AD'...] }
    game_times = {}   # { 'LAL': '7:00 PM' }
    
    for row in rows:
        cells = row.find_all(['td', 'th'])
        cols_text = [c.get_text(strip=True) for c in cells]
        
        if not cols_text: continue
        
        # A. Detect Header Row (Game Info)
        # Looks for "@" in 2nd or 3rd column
        is_header = False
        raw_away, raw_home, time_str = "", "", "7:00 PM"
        
        if len(cols_text) >= 3:
            if "@" in cols_text[2]: # Format: [Time, Away, @Home]
                time_str = cols_text[0]
                raw_away = cols_text[1]
                raw_home = cols_text[2]
                is_header = True
            elif "@" in cols_text[1]: # Format: [Away, @Home]
                raw_away = cols_text[0]
                raw_home = cols_text[1]
                is_header = True
        
        if is_header:
            team_away = normalize_team(raw_away.replace('@', '').strip())
            team_home = normalize_team(raw_home.replace('@', '').strip())
            
            # Clean Time
            if ':' in time_str and ('am' in time_str.lower() or 'pm' in time_str.lower()):
                time_str = time_str.upper()
            else:
                time_str = "7:00 PM"

            if team_away not in starters_map: starters_map[team_away] = []
            if team_home not in starters_map: starters_map[team_home] = []
            
            game_times[team_away] = time_str
            game_times[team_home] = time_str
            continue

        # B. Detect Player Row
        # Check if first col is a position (PG, SG, etc)
        if len(cols_text) >= 3 and cols_text[0] in ['PG', 'SG', 'SF', 'PF', 'C']:
            if not starters_map: continue
            
            # The last two teams added to the map are the current game
            active_teams = list(starters_map.keys())[-2:]
            tm_away = active_teams[0]
            tm_home = active_teams[1]
            
            # Extract Away Player (Col 1)
            # STRICT RULE: Only use if <a> tag with 'playerinfo.aspx?i=' exists
            if len(starters_map[tm_away]) < 5: # STOP AT 5
                link = cells[1].find('a', href=True)
                if link and 'playerinfo.aspx' in link['href']:
                    name = link.get_text(strip=True)
                    starters_map[tm_away].append(name)

            # Extract Home Player (Col 2)
            if len(starters_map[tm_home]) < 5: # STOP AT 5
                link = cells[2].find('a', href=True)
                if link and 'playerinfo.aspx' in link['href']:
                    name = link.get_text(strip=True)
                    starters_map[tm_home].append(name)

    print(f"Scraped {len(starters_map)} teams.")
    return starters_map, game_times

# --- STEP 2: LOAD CSV ---
def load_cheat_sheet():
    files = glob.glob('*DFF*.csv')
    if not files:
        print("ERROR: No DFF Cheat Sheet found.")
        return pd.DataFrame()
    
    path = sorted(files)[-1]
    print(f"Loading Cheat Sheet: {path}")
    
    try:
        df = pd.read_csv(path)
        # Normalize for matching
        df['norm_team'] = df['team'].apply(normalize_team)
        df['clean_name'] = df.apply(lambda x: clean_player_name(f"{x['first_name']} {x['last_name']}"), axis=1)
        df['last_name_lower'] = df['last_name'].str.lower().str.strip()
        df['first_initial'] = df['first_name'].str[0].str.lower()
        return df
    except Exception as e:
        print(f"Error reading CSV: {e}")
        return pd.DataFrame()

# --- STEP 3: MAIN LOGIC ---
def build_json():
    # 1. Scrape
    scraped_rosters, game_times = scrape_starters()
    
    # 2. Load Stats
    stats_df = load_cheat_sheet()
    
    # 3. Build Games
    # We iterate through the SCRAPED TEAMS to define the games.
    # We pair them up based on the order they were scraped (Away, Home, Away, Home...)
    # Or rely on the fact they share the same 'time' and are adjacent.
    
    teams_list = list(scraped_rosters.keys())
    games_output = []
    processed_teams = set()
    
    utc_now = datetime.utcnow()
    et_now = utc_now - timedelta(hours=5)
    formatted_time = et_now.strftime("%b %d, %I:%M %p ET")
    
    print("\n--- MATCHING PLAYERS ---")

    for i in range(0, len(teams_list), 2):
        if i+1 >= len(teams_list): break
        
        team_a = teams_list[i]
        team_b = teams_list[i+1]
        
        game_time = game_times.get(team_a, "7:00 PM")
        
        # Lookup Spread/Total from CSV if possible
        spread_str = "TBD"
        total_str = "TBD"
        
        if not stats_df.empty:
            meta_row = stats_df[stats_df['norm_team'] == team_a]
            if not meta_row.empty:
                s = meta_row.iloc[0].get('spread', 0)
                spread_str = f"{s}" if s < 0 else f"+{s}"
                total_str = str(meta_row.iloc[0].get('over_under', 'TBD'))

        game_obj = {
            "id": f"{team_a}-{team_b}",
            "sort_index": parse_time_to_minutes(game_time),
            "teams": [team_a, team_b],
            "meta": {
                "spread": spread_str,
                "total": total_str,
                "time": game_time
            },
            "rosters": {}
        }
        
        # Process Roster for each team in this game
        for team in [team_a, team_b]:
            starters_names = scraped_rosters.get(team, [])
            player_list = []
            
            # Loop through the SCRAPED names (Source of Truth)
            for raw_name in starters_names:
                clean = clean_player_name(raw_name)
                
                # Default Stats
                p_data = {
                    "pos": "Flex", # Placeholder
                    "name": raw_name,
                    "salary": 0,
                    "proj": 0,
                    "value": 0,
                    "injury": ""
                }
                
                # Try to find stats in CSV
                if not stats_df.empty:
                    # 1. Exact Match
                    match = stats_df[
                        (stats_df['norm_team'] == team) & 
                        (stats_df['clean_name'] == clean)
