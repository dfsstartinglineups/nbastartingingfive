import pandas as pd
import json
import glob
import os
import datetime
import requests
import sys
from bs4 import BeautifulSoup
from datetime import timedelta

# --- CONFIGURATION ---
BBM_URL = "https://basketballmonster.com/nbalineups.aspx"

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
}

# STANDARD TEAM CODES
TEAM_MAP = {
    'GS': 'GSW', 'GOLDEN STATE': 'GSW',
    'NO': 'NOP', 'NEW ORLEANS': 'NOP',
    'NY': 'NYK', 'NEW YORK': 'NYK',
    'SA': 'SAS', 'SAN ANTONIO': 'SAS',
    'PHO': 'PHX', 'PHOENIX': 'PHX',
    'UT': 'UTA', 'UTAH': 'UTA',
    'WSH': 'WAS', 'WASHINGTON': 'WAS',
    'BKO': 'BKN', 'BROOKLYN': 'BKN'
}

def normalize_team(team_name):
    if pd.isna(team_name): return ""
    clean_name = str(team_name).strip().upper()
    return TEAM_MAP.get(clean_name, clean_name)

def clean_player_name(name):
    """Removes injury tags."""
    if not name: return ""
    tags = [' Q', ' Out', ' IN', ' GTD', ' P', ' Probable', ' Questionable', ' Doubtful']
    for tag in tags:
        if name.endswith(tag):
            name = name[:-len(tag)]
    return name.strip()

def get_starters_from_basketball_monster():
    print(f"Fetching lineups from {BBM_URL}...")
    starters = {}
    
    try:
        response = requests.get(BBM_URL, headers=HEADERS, timeout=10)
        if response.status_code != 200:
            print(f"Error: BBM returned status {response.status_code}")
            return {}

        soup = BeautifulSoup(response.text, 'html.parser')
        rows = soup.find_all('tr')
        
        current_away = None
        current_home = None
        
        for row in rows:
            cols = [c.get_text(strip=True) for c in row.find_all(['td', 'th'])]
            
            # Skip empty or malformed rows
            if not cols: continue
            
            # HEADER ROW DETECTION (e.g. "MEM", "@ MIN")
            # BBM usually puts "@" before the home team in the 3rd column
            # We look for a row where column 2 has '@' (sometimes) or column 3 has '@'
            # Typical row: [Time, AwayTeam, @HomeTeam]
            if len(cols) >= 3 and ("@" in cols[2] or "@" in cols[1]):
                # Extract clean team names
                raw_away = cols[1].replace('@', '').strip()
                raw_home = cols[2].replace('@', '').strip()
                
                current_away = normalize_team(raw_away)
                current_home = normalize_team(raw_home)
                
                # Initialize lists
                if current_away not in starters: starters[current_away] = []
                if current_home not in starters: starters[current_home] = []
                continue
                
            # PLAYER ROW DETECTION
            # First column is usually Position (PG, SG, SF, PF, C)
            if len(cols) >= 3 and cols[0] in ['PG', 'SG', 'SF', 'PF', 'C']:
                if current_away and current_home:
                    p_away = clean_player_name(cols[1])
                    p_home = clean_player_name(cols[2])
                    
                    if p_away and p_away != "-": 
                        starters[current_away].append(p_away)
                    if p_home and p_home != "-": 
                        starters[current_home].append(p_home)

    except Exception as e:
        print(f"Error parsing BBM: {e}")
        
    print(f"Found lineups for {len(starters)} teams.")
    return starters

def build_json():
    print("--- Starting NBA Data Build ---")

    # 1. FIND CSV FILES
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

    dff_df['norm_first'] = dff_df['first_name'].str.lower().str.strip()
    dff_df['norm_last'] = dff_df['last_name'].str.lower().str.strip()
    dff_df['norm_team'] = dff_df['team'].str.strip()
    
    fd_df['norm_first'] = fd_df['First Name'].str.lower().str.strip()
    fd_df['norm_last'] = fd_df['Last Name'].str.lower().str.strip()
    fd_df['norm_team'] = fd_df['Team'].str.strip()
    
    # 4. MERGE DATA
    merged_df = pd.merge(dff_df, fd_df, 
        left_on=['norm_first', 'norm_last', 'norm_team'],
        right_on=['norm_first', 'norm_last', 'norm_team'],
        how='inner'
    )
    merged_df = merged_df.drop_duplicates(subset=['norm_first', 'norm_last', 'norm_team'])

    # 5. GET WEB STARTERS (ONLY FROM BBM)
    web_starters = get_starters_from_basketball_monster()

    # Normalize web data names
    web_starters_norm = {}
    for team, players in web_starters.items():
        norm_team = normalize_team(team)
        web_starters_norm[norm_team] = [p.lower().strip() for p in players]

    merged_df['Full_Name'] = merged_df['first_name'] + " " + merged_df['last_name']
    merged_df['Full_Name_Norm'] = merged_df['Full_Name'].str.lower().str.strip()
    merged_df['Is_Starter'] = False
    
    # 6. MATCH STARTERS
    unique_teams = merged_df['team'].unique()
    
    for team in unique_teams:
        team_players = merged_df[merged_df['team'] == team]
        starters_list = web_starters_norm.get(team, [])
        
        # Only mark as starter if we found a match from the web list
        if starters_list:
            mask = team_players['Full_Name_Norm'].apply(lambda x: any(s in x for s in starters_list) or any(x in s for s in starters_list))
            if mask.any():
                merged_df.loc[team_players[mask].index, 'Is_Starter'] = True
        
        # Note: We removed the fallback logic. If no starters found, Is_Starter stays False.

    # 7. BUILD JSON
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
        
        game_obj = {
            "id": f"{team}-{opp}",
            "teams": [team, opp],
            "meta": {
                "spread": spread_str,
                "total": str(meta.get('over_under', 'TBD')),
            },
            "rosters": {}
        }
        
        for current_team in [team, opp]:
            # Filter for Is_Starter == True
            starters_df = merged_df[
                (merged_df['team'] == current_team) & 
                (merged_df['Is_Starter'] == True)
            ].copy()
            
            player_list = []
            
            # If we have starters, sort and add them
            if not starters_df.empty:
                starters_df = starters_df.sort_values('Pos_Rank')
                for _, p in starters_df.iterrows():
                    val = p['ppg_projection'] / (p['salary']/1000) if p['salary'] > 0 else 0
                    inj = str(p['injury_status']) if pd.notna(p['injury_status']) and str(p['injury_status']) != 'nan' else ""
                    
                    player_list.append({
                        "pos": p['position'],
                        "name": p['Full_Name'],
                        "salary": int(p['salary']),
                        "proj": round(p['ppg_projection'], 1),
                        "value": round(val, 2),
                        "injury": inj
                    })
            else:
                # If no starters found, add "Waiting for Lineup" placeholder
                player_list.append({
                    "pos": "-",
                    "name": "Waiting for Lineup",
                    "salary": 0,
                    "proj": 0,
                    "value": 0,
                    "injury": ""
                })

            game_obj['rosters'][current_team] = {
                "logo": f"{logo_base}{current_team.lower()}.png",
                "players": player_list
            }
            
        data_export['games'].append(game_obj)
        
    with open('nba_data.json', 'w') as f:
        json.dump(data_export, f, indent=2)
    print("SUCCESS: nba_data.json updated.")

if __name__ == "__main__":
    build_json()
