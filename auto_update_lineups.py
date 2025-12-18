import pandas as pd
import json
import glob
import os
import datetime
import requests
import sys
import re
from datetime import datetime as dt, timedelta

# --- CONFIGURATION ---
BBM_URL = "https://basketballmonster.com/nbalineups.aspx"

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
}

# STANDARD TEAM CODES
TEAM_MAP = {
    'GS': 'GSW', 'GOLDEN STATE': 'GSW', 'GSW': 'GSW',
    'NO': 'NOP', 'NEW ORLEANS': 'NOP', 'NOP': 'NOP', 'NOH': 'NOP', 'PELICANS': 'NOP',
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
    'pj': 'pj', 'trey': 'trey', 'cj': 'cj', 'c.j.': 'cj'
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
        t = dt.strptime(time_str.strip().upper(), "%I:%M %p")
        return t.hour * 60 + t.minute
    except:
        return 9999

def get_data_from_basketball_monster():
    print(f"Fetching from {BBM_URL}...")
    starters = {}
    game_times = {}
    
    try:
        response = requests.get(BBM_URL, headers=HEADERS, timeout=10)
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(response.text, 'html.parser')
        
        rows = soup.find_all('tr')
        
        for row in rows:
            cells = row.find_all(['td', 'th'])
            cols_text = [c.get_text(strip=True) for c in cells]
            
            if not cols_text: continue
            
            # --- HEADER ROW DETECTION ---
            is_header = False
            raw_away, raw_home = "", ""
            potential_time = ""

            if len(cols_text) >= 3:
                # Format 1: [Time, Away, @Home]
                if "@" in cols_text[2]:
                    potential_time = cols_text[0]
                    raw_away, raw_home = cols_text[1], cols_text[2]
                    is_header = True
                # Format 2: [Away, @Home]
                elif "@" in cols_text[1]:
                    potential_time = "7:00 PM"
                    raw_away, raw_home = cols_text[0], cols_text[1]
                    is_header = True
            
            if is_header:
                game_time = "7:00 PM"
                if ':' in potential_time and ('am' in potential_time.lower() or 'pm' in potential_time.lower()):
                    game_time = potential_time.upper()
                
                raw_away = raw_away.replace('@', '').strip()
                raw_home = raw_home.replace('@', '').strip()
                
                team_away = normalize_team(raw_away)
                team_home = normalize_team(raw_home)
                
                if team_away not in starters: starters[team_away] = []
                if team_home not in starters: starters[team_home] = []
                
                game_times[team_away] = game_time
                game_times[team_home] = game_time
                continue
            
            # --- PLAYER ROW DETECTION (USING LINKS) ---
            if len(cols_text) >= 3 and cols_text[0] in ['PG', 'SG', 'SF', 'PF', 'C']:
                if not starters: continue
                
                active_teams = list(starters.keys())[-2:] 
                tm_away = active_teams[0]
                tm_home = active_teams[1]
                
                # Check Away Link
                link_away = cells[1].find('a', href=True)
                if link_away and 'playerinfo.aspx' in link_away['href']:
                    raw = link_away.get_text(strip=True)
                    clean = clean_player_name(raw)
                    if clean: 
                        starters[tm_away].append(clean)
                        print(f"RAW WEB: Found {clean} for {tm_away}")

                # Check Home Link
                link_home = cells[2].find('a', href=True)
                if link_home and 'playerinfo.aspx' in link_home['href']:
                    raw = link_home.get_text(strip=True)
                    clean = clean_player_name(raw)
                    if clean: 
                        starters[tm_home].append(clean)
                        print(f"RAW WEB: Found {clean} for {tm_home}")

    except Exception as e:
        print(f"Error parsing BBM: {e}")
        
    return starters, game_times

def build_json():
    print(f"--- Starting Build at {datetime.datetime.utcnow()} UTC ---")

    # 1. LOAD FILES
    dff_files = glob.glob('*DFF*.csv')
    fd_files = glob.glob('*FanDuel*.csv')
    
    if not dff_files or not fd_files:
        print("ERROR: MISSING CSV FILES")
        sys.exit(1)

    dff_path = sorted(dff_files)[-1]
    fd_path = sorted(fd_files)[-1]
    
    try:
        dff_df = pd.read_csv(dff_path)
        fd_df = pd.read_csv(fd_path)
    except Exception as e:
        print(f"Error reading CSVs: {e}")
        sys.exit(1)

    # 2. MERGE DATA
    dff_df['team'] = dff_df['team'].apply(normalize_team)
    dff_df['opp'] = dff_df['opp'].apply(normalize_team)
    fd_df['Team'] = fd_df['Team'].apply(normalize_team)

    dff_df['norm_first'] = dff_df['first_name'].str.lower().str.strip()
    dff_df['norm_last'] = dff_df['last_name'].str.lower().str.strip()
    dff_df['norm_team'] = dff_df['team'].str.strip()
    
    fd_df['norm_first'] = fd_df['First Name'].str.lower().str.strip()
    fd_df['norm_last'] = fd_df['Last Name'].str.lower().str.strip()
    fd_df['norm_team'] = fd_df['Team'].str.strip()
    
    merged_df = pd.merge(dff_df, fd_df, 
        left_on=['norm_first', 'norm_last', 'norm_team'],
        right_on=['norm_first', 'norm_last', 'norm_team'],
        how='inner'
    )
    merged_df = merged_df.drop_duplicates(subset=['norm_first', 'norm_last', 'norm_team'])
    
    merged_df['Clean_Name'] = merged_df.apply(
        lambda x: clean_player_name(f"{x['first_name']} {x['last_name']}"), axis=1
    )
    merged_df['Last_Name_Lower'] = merged_df['last_name'].str.lower().str.strip()

    # 3. GET WEB DATA
    web_starters, web_times = get_data_from_basketball_monster()
    
    # 4. MATCH STARTERS
    merged_df['Is_Starter'] = False
    unique_teams = merged_df['team'].unique()
    
    print("\n--- BEGIN MATCHING PROCESS ---")
    
    for team in unique_teams:
        starters_list = web_starters.get(team, [])
        if not starters_list: 
            print(f"Skipping {team}: No web data found.")
            continue
        
        for web_p in starters_list:
            # A. Exact Match
            exact_mask = (merged_df['team'] == team) & (merged_df['Clean_Name'] == web_p)
            if exact_mask.any():
                merged_df.loc[exact_mask.index, 'Is_Starter'] = True
                print(f"  [MATCH] '{web_p}' -> Exact Match")
                continue
            
            # B. Last Name Fallback
            parts = web_p.split()
            if len(parts) >= 2:
                web_last = parts[-1]
                candidates = merged_df[
                    (merged_df['team'] == team) & 
                    (merged_df['Last_Name_Lower'] == web_last)
                ]
                if len(candidates) == 1:
                    merged_df.loc[candidates.index, 'Is_Starter'] = True
                    matched_name = candidates.iloc[0]['Clean_Name']
                    print(f"  [MATCH] '{web_p}' -> Unique Last Name Match ({matched_name})")
                    continue
                else:
                    print(f"  [FAIL] '{web_p}' -> Ambiguous or Not Found ({len(candidates)} candidates)")
            else:
                print(f"  [FAIL] '{web_p}' -> Could not parse name")

    # 5. BUILD OUTPUT
    utc_now = datetime.datetime.utcnow()
    et_now = utc_now - timedelta(hours=5)
    formatted_time = et_now.strftime("%b %d, %I:%M %p ET")

    data_export = {"last_updated": formatted_time, "games": []}

    def position_rank(pos_str):
        if not isinstance(pos_str, str): return 99
        primary_pos = pos_str.split('/')[0]
        order = {'PG': 1, 'SG': 2, 'SF': 3, 'PF': 4, 'C': 5}
        return order.get(primary_pos, 99)
    
    merged_df['Pos_Rank'] = merged_df['position'].apply(position_rank)
    meta_lookup = dff_df[['team', 'opp', 'spread', 'over_under']].drop_duplicates().set_index('team').to_dict('index')
    logo_base = "https://a.espncdn.com/i/teamlogos/nba/500/"
    
    games_list = []
    processed_teams = set()
    
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
        
        game_time = web_times.get(team, "7:00 PM")
        sort_val = parse_time_to_minutes(game_time)
        
        game_obj = {
            "id": f"{team}-{opp}",
            "sort_index": sort_val,
            "teams": [team, opp],
            "meta": {
                "spread": spread_str,
                "total": str(meta.get('over_under', 'TBD')),
                "time": game_time
            },
            "rosters": {}
        }
        
        for current_team in [team, opp]:
            starters_df = merged_df[
                (merged_df['team'] == current_team) & 
                (merged_df['Is_Starter'] == True)
            ].sort_values('Pos_Rank')
            
            player_list = []
            
            # Show ONLY if we have at least 1 starter found
            # Clamp to 5 max
            starters_df = starters_df.head(5)
            
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
    
    games_list.sort(key=lambda x: x['sort_index'])
    for g in games_list: del g['sort_index']
    
    data_export['games'] = games_list
    
    with open('nba_data.json', 'w') as f:
        json.dump(data_export, f, indent=2)
    print("SUCCESS: nba_data.json updated.")

if __name__ == "__main__":
    build_json()
