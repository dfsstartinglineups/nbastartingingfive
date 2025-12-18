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
ROTOWIRE_URL = "https://www.rotowire.com/basketball/nba-lineups.php"

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
    """Removes tags. Returns None if player is explicitly OUT."""
    if not name: return None
    
    # If explicitly marked Out in the name string, skip him
    if ' Out' in name or ' O ' in name:
        return None
        
    tags = [' Q', ' IN', ' GTD', ' P', ' Probable', ' Questionable', ' Doubtful']
    for tag in tags:
        if name.endswith(tag):
            name = name[:-len(tag)]
            
    return name.strip()

def get_starters_from_basketball_monster():
    print(f"Checking {BBM_URL}...")
    starters = {}
    try:
        response = requests.get(BBM_URL, headers=HEADERS, timeout=10)
        soup = BeautifulSoup(response.text, 'html.parser')
        rows = soup.find_all('tr')
        current_away = None
        current_home = None
        
        for row in rows:
            cols = [c.get_text(strip=True) for c in row.find_all(['td', 'th'])]
            if not cols: continue
            
            # Header Row
            if len(cols) >= 3 and "@" in cols[2]:
                current_away = normalize_team(cols[1].replace('@', ''))
                current_home = normalize_team(cols[2].replace('@', ''))
                if current_away not in starters: starters[current_away] = []
                if current_home not in starters: starters[current_home] = []
                continue
                
            # Player Row
            if len(cols) >= 3 and cols[0] in ['PG', 'SG', 'SF', 'PF', 'C']:
                if current_away and current_home:
                    p_away = clean_player_name(cols[1])
                    p_home = clean_player_name(cols[2])
                    
                    if p_away and p_away != "-": starters[current_away].append(p_away)
                    if p_home and p_home != "-": starters[current_home].append(p_home)
    except Exception as e:
        print(f"Warning: BBM check failed ({e})")
    return starters

def get_starters_from_rotowire():
    print(f"Checking {ROTOWIRE_URL}...")
    starters = {} 
    try:
        response = requests.get(ROTOWIRE_URL, headers=HEADERS, timeout=10)
        soup = BeautifulSoup(response.text, 'html.parser')
        lineup_boxes = soup.find_all(class_='lineup')
        for box in lineup_boxes:
            lists = box.find_all(class_='lineup__list')
            if len(lists) < 2: continue
            for ul in lists:
                is_home = 'is-home' in ul.get('class', [])
                team_div_class = 'is-home' if is_home else 'is-visit'
                team_div = box.find(class_=f'lineup__team {team_div_class}')
                if not team_div: continue
                
                team_code = normalize_team(team_div.text)
                
                players = []
                for li in ul.find_all('li', class_='lineup__player'):
                    name_tag = li.find('a')
                    if name_tag:
                        raw_name = name_tag.get('title') or name_tag.text
                        clean_name = clean_player_name(raw_name)
                        if clean_name:
                            players.append(clean_name)
                if players:
                    starters[team_code] = players
    except Exception as e:
        print(f"Warning: Rotowire check failed ({e})")
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
    
    # 4. MERGE
    merged_df = pd.merge(dff_df, fd_df, 
        left_on=['norm_first', 'norm_last', 'norm_team'],
        right_on=['norm_first', 'norm_last', 'norm_team'],
        how='inner'
    )
    merged_df = merged_df.drop_duplicates(subset=['norm_first', 'norm_last', 'norm_team'])

    # 5. GET WEB STARTERS
    web_starters = get_starters_from_basketball_monster()
    
    unique_teams = merged_df['team'].unique()
    missing_teams = [t for t in unique_teams if t not in web_starters or len(web_starters[t]) < 5]
    
    if missing_teams:
        print(f"Checking Rotowire for missing teams: {missing_teams}")
        rw_starters = get_starters_from_rotowire()
        for t in missing_teams:
            if t in rw_starters:
                web_starters[t] = rw_starters[t]

    # Normalize web data
    web_starters_norm = {}
    for team, players in web_starters.items():
        norm_team = normalize_team(team)
        web_starters_norm[norm_team] = [p.lower().strip() for p in players]

    merged_df['Full_Name'] = merged_df['first_name'] + " " + merged_df['last_name']
    merged_df['Full_Name_Norm'] = merged_df['Full_Name'].str.lower().str.strip()
    merged_df['Is_Starter'] = False
    
    # 6. MARK STARTERS & APPLY INJURY FILTER
    for team in unique_teams:
        team_players = merged_df[merged_df['team'] == team]
        starters_list = web_starters_norm.get(team, [])
        
        # A. Match names from web
        if starters_list:
            mask = team_players['Full_Name_Norm'].apply(lambda x: any(s in x for s in starters_list) or any(x in s for s in starters_list))
            if mask.any():
                merged_df.loc[team_players[mask].index, 'Is_Starter'] = True
        
        # B. STRICT INJURY FILTER
        # If player is 'O' in CSV, remove Starter status
        injured_mask = (merged_df['team'] == team) & (merged_df['Is_Starter'] == True) & (merged_df['injury_status'] == 'O')
        if injured_mask.any():
            print(f"[{team}] Removing injured starters: {merged_df.loc[injured_mask.index, 'Full_Name'].values}")
            merged_df.loc[injured_mask.index, 'Is_Starter'] = False

        # C. Safety Fill
        current_count = merged_df[(merged_df['team'] == team) & (merged_df['Is_Starter'] == True)].shape[0]
        if current_count < 5:
            needed = 5 - current_count
            
            # Find candidates: Same Team, Not Starter, Not Injured 'O'
            candidates = merged_df[
                (merged_df['team'] == team) & 
                (merged_df['Is_Starter'] == False) & 
                (merged_df['injury_status'] != 'O')
            ]
            candidates = candidates.sort_values('ppg_projection', ascending=False)
            fillers = candidates.head(needed)
            merged_df.loc[fillers.index, 'Is_Starter'] = True

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
            team_subset = merged_df[merged_df['team'] == current_team].copy()
            # Sort: Starters First, then Position
            team_subset = team_subset.sort_values(
                by=['Is_Starter', 'Pos_Rank', 'ppg_projection'], 
                ascending=[False, True, False]
            )
            
            starters = team_subset.head(5)
            
            player_list = []
            for _, p in starters.iterrows():
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
