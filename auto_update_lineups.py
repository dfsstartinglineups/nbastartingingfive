import pandas as pd
import json
import glob
import os
import requests
import re
from datetime import datetime, timedelta

# --- CONFIGURATION ---
BBM_URL = "https://basketballmonster.com/nbalineups.aspx"

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
}

# STANDARD TEAM CODES
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

# NICKNAME MAP
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
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(response.text, 'html.parser')
        rows = soup.find_all('tr')
    except Exception as e:
        print(f"CRITICAL ERROR SCRAPING: {e}")
        return {}, {}

    starters_map = {} 
    game_times = {}
    
    for row in rows:
        cells = row.find_all(['td', 'th'])
        cols_text = [c.get_text(strip=True) for c in cells]
        
        if not cols_text: continue
        
        # A. Detect Header Row
        is_header = False
        raw_away, raw_home, time_str = "", "", "7:00 PM"
        
        if len(cols_text) >= 3:
            if "@" in cols_text[2]: 
                time_str = cols_text[0]
                raw_away, raw_home = cols_text[1], cols_text[2]
                is_header = True
            elif "@" in cols_text[1]: 
                raw_away, raw_home = cols_text[0], cols_text[1]
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
        if len(cols_text) >= 3 and cols_text[0] in ['PG', 'SG', 'SF', 'PF', 'C']:
            if not starters_map: continue
            
            active_teams = list(starters_map.keys())[-2:]
            tm_away = active_teams[0]
            tm_home = active_teams[1]
            
            # Helper to extract name + verified status
            def extract_player_info(cell):
                link = cell.find('a', href=True)
                if link and 'playerinfo.aspx' in link['href']:
                    name = link.get_text(strip=True)
                    # Check for 'verified' class in the TD
                    classes = cell.get('class', [])
                    is_verified = 'verified' in classes
                    return {'name': name, 'verified': is_verified}
                return None

            # Extract Away Player (Strict 5 Limit)
            if len(starters_map[tm_away]) < 5:
                p_info = extract_player_info(cells[1])
                if p_info: starters_map[tm_away].append(p_info)

            # Extract Home Player (Strict 5 Limit)
            if len(starters_map[tm_home]) < 5:
                p_info = extract_player_info(cells[2])
                if p_info: starters_map[tm_home].append(p_info)

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
        df['norm_team'] = df['team'].apply(normalize_team)
        if 'first_name' in df.columns and 'last_name' in df.columns:
            df['clean_name'] = df.apply(lambda x: clean_player_name(f"{x['first_name']} {x['last_name']}"), axis=1)
            df['last_name_lower'] = df['last_name'].str.lower().str.strip()
            df['first_initial'] = df['first_name'].str[0].str.lower()
        else:
            print("WARNING: Columns missing in DFF file.")
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
    teams_list = list(scraped_rosters.keys())
    games_output = []
    
    utc_now = datetime.utcnow()
    et_now = utc_now - timedelta(hours=5)
    formatted_time = et_now.strftime("%b %d, %I:%M %p ET")
    
    print("\n--- MATCHING PLAYERS ---")

    for i in range(0, len(teams_list), 2):
        if i+1 >= len(teams_list): break
        
        team_a = teams_list[i]
        team_b = teams_list[i+1]
        
        game_time = game_times.get(team_a, "7:00 PM")
        
        # Meta Lookup
        spread_str = "TBD"
        total_str = "TBD"
        if not stats_df.empty:
            meta_row = stats_df[stats_df['norm_team'] == team_a]
            if not meta_row.empty:
                try:
                    s_val = meta_row.iloc[0].get('spread', 0)
                    s = float(str(s_val).replace('+', ''))
                    spread_str = f"{s}" if s < 0 else f"+{s}"
                    t_val = meta_row.iloc[0].get('over_under', 'TBD')
                    total_str = str(t_val)
                except: pass

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
        
        for team in [team_a, team_b]:
            starters_data = scraped_rosters.get(team, [])
            player_list = []
            
            for p_obj in starters_data:
                raw_name = p_obj['name']
                is_verified = p_obj['verified']
                clean = clean_player_name(raw_name)
                
                # Default
                p_data = {
                    "pos": "Flex", 
                    "name": raw_name,
                    "salary": 0,
                    "proj": 0,
                    "value": 0,
                    "injury": "",
                    "verified": is_verified # Add to JSON
                }
                
                # Match in CSV
                if not stats_df.empty:
                    match = stats_df[
                        (stats_df['norm_team'] == team) & 
                        (stats_df['clean_name'] == clean)
                    ]
                    
                    if match.empty:
                        parts = clean.split()
                        if len(parts) >= 2:
                            last = parts[-1]
                            first_init = parts[0][0]
                            match = stats_df[
                                (stats_df['norm_team'] == team) & 
                                (stats_df['last_name_lower'] == last) &
                                (stats_df['first_initial'] == first_init)
                            ]
                    
                    if match.empty and len(clean.split()) >= 2:
                         last = clean.split()[-1]
                         candidates = stats_df[
                            (stats_df['norm_team'] == team) & 
                            (stats_df['last_name_lower'] == last)
                         ]
                         if len(candidates) == 1:
                             match = candidates

                    if not match.empty:
                        row = match.iloc[0]
                        val = 0
                        try:
                            sal = float(row['salary'])
                            proj = float(row['ppg_projection'])
                            if sal > 0: val = proj / (sal/1000)
                            
                            p_data = {
                                "pos": row['position'],
                                "name": f"{row['first_name']} {row['last_name']}",
                                "salary": int(sal),
                                "proj": round(proj, 1),
                                "value": round(val, 2),
                                "injury": str(row['injury_status']) if pd.notna(row['injury_status']) else "",
                                "verified": is_verified
                            }
                            print(f"  [MATCH] {raw_name} {'(Verified)' if is_verified else ''}")
                        except: pass
                    else:
                        print(f"  [NO STATS] {raw_name}")
                
                player_list.append(p_data)
            
            if not player_list:
                 player_list.append({
                    "pos": "-", "name": "Waiting for Lineup",
                    "salary": 0, "proj": 0, "value": 0, "injury": "", "verified": False
                })

            game_obj['rosters'][team] = {
                "logo": f"https://a.espncdn.com/i/teamlogos/nba/500/{team.lower()}.png",
                "players": player_list
            }
            
        games_output.append(game_obj)

    games_output.sort(key=lambda x: x['sort_index'])
    for g in games_output: del g['sort_index']
    
    final_json = {
        "last_updated": formatted_time,
        "games": games_output
    }
    
    with open('nba_data.json', 'w') as f:
        json.dump(final_json, f, indent=2)
    
    print(f"SUCCESS. Generated {len(games_output)} games.")

if __name__ == "__main__":
    build_json()
