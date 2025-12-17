import pandas as pd
import json
import glob
import os
import datetime
import requests
import sys
from bs4 import BeautifulSoup

# --- CONFIGURATION ---
BBM_URL = "https://basketballmonster.com/nbalineups.aspx"
ROTOWIRE_URL = "https://www.rotowire.com/basketball/nba-lineups.php"

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
}

def get_starters_from_basketball_monster():
    print(f"Fetching lineups from {BBM_URL}...")
    starters = {}
    
    try:
        response = requests.get(BBM_URL, headers=HEADERS, timeout=10)
        soup = BeautifulSoup(response.text, 'html.parser')
        
        # Find all tables (BBM usually puts each game in a table or one big grid)
        # We look for rows that start with a position like "PG"
        rows = soup.find_all('tr')
        
        # We need to track which game/teams we are currently processing
        current_away_team = None
        current_home_team = None
        
        # BBM Structure is often: Header Row (Teams) -> Player Rows
        # We will iterate through all rows to find headers then players
        for row in rows:
            cols = [c.get_text(strip=True) for c in row.find_all(['td', 'th'])]
            
            if not cols: continue
            
            # CHECK FOR HEADER: Look for "@" or known team codes to identify a new game block
            # Example header: ["", "CLE", "@ CHI"] or ["PG", "Player", "Player"]
            # Let's try to find the team row.
            
            # Logic: If row has 3 columns and middle one is a Team Code
            if len(cols) >= 3:
                # Cleaning
                col1, col2, col3 = cols[0], cols[1], cols[2]
                
                # Check if this is a header row with teams (e.g., "MEM", "@ MIN")
                # We assume Team Codes are 3 letters. 
                # BBM often puts "@" in front of home team.
                is_header = False
                if "@" in col3:
                    current_away_team = col2.replace('@', '').strip()
                    current_home_team = col3.replace('@', '').strip()
                    is_header = True
                
                # If we found teams, initialize them in our dict
                if is_header:
                    if current_away_team and current_away_team not in starters: starters[current_away_team] = []
                    if current_home_team and current_home_team not in starters: starters[current_home_team] = []
                    continue

                # CHECK FOR PLAYER ROW
                # First col should be a position (PG, SG, SF, PF, C)
                if col1 in ['PG', 'SG', 'SF', 'PF', 'C'] and current_away_team and current_home_team:
                    # Away Player is col 2, Home Player is col 3
                    
                    # Clean names (Remove status like ' Q', ' IN', ' Out')
                    # Function to clean name
                    def clean_name(txt):
                        # Remove common status suffixes if attached
                        for suffix in [' Q', ' IN', ' Out', ' GTD', ' P', ' D', ' Probable', ' Questionable']:
                            if txt.endswith(suffix):
                                txt = txt[:-len(suffix)]
                        return txt.strip()

                    away_player = clean_name(col2)
                    home_player = clean_name(col3)
                    
                    if away_player and away_player != "-":
                        starters[current_away_team].append(away_player)
                    if home_player and home_player != "-":
                        starters[current_home_team].append(home_player)

    except Exception as e:
        print(f"BBM Scraping Error: {e}")
        
    print(f"BBM Found starters for: {list(starters.keys())}")
    return starters

def get_confirmed_starters_from_rotowire():
    print(f"Fetching lineups from {ROTOWIRE_URL}...")
    confirmed_starters = {} 
    
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
                team_code = team_div.text.strip()
                
                players = []
                for li in ul.find_all('li', class_='lineup__player'):
                    name_tag = li.find('a')
                    if name_tag:
                        name = name_tag.get('title') or name_tag.text
                        players.append(name)
                
                if players:
                    confirmed_starters[team_code] = players
                    
    except Exception as e:
        print(f"Rotowire Scraping Error: {e}")
        
    return confirmed_starters

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

    # 2. LOAD & MERGE
    try:
        dff_df = pd.read_csv(dff_path)
        fd_df = pd.read_csv(fd_path)
    except Exception as e:
        print(f"Error reading CSVs: {e}")
        sys.exit(1)

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

    # 3. GET WEB STARTERS (Chain Logic)
    # Try BBM first
    web_starters = get_starters_from_basketball_monster()
    
    # If BBM missed any teams, try Rotowire to fill gaps
    unique_teams_in_csv = merged_df['team'].unique()
    missing_teams = [t for t in unique_teams_in_csv if t not in web_starters or len(web_starters[t]) < 5]
    
    if missing_teams:
        print(f"Checking Rotowire for missing teams: {missing_teams}")
        rw_starters = get_confirmed_starters_from_rotowire()
        for t in missing_teams:
            if t in rw_starters:
                web_starters[t] = rw_starters[t]

    # Normalize names
    web_starters_norm = {}
    for team, players in web_starters.items():
        norm_team = team.strip()
        web_starters_norm[norm_team] = [p.lower().strip() for p in players]

    merged_df['Full_Name'] = merged_df['first_name'] + " " + merged_df['last_name']
    merged_df['Full_Name_Norm'] = merged_df['Full_Name'].str.lower().str.strip()
    
    merged_df['Is_Starter'] = False
    
    # 4. IDENTIFY STARTERS
    unique_teams = merged_df['team'].unique()
    
    for team in unique_teams:
        team_players = merged_df[merged_df['team'] == team]
        starters_list = web_starters_norm.get(team, [])
        
        # A. Match Web Names
        if starters_list:
            mask = team_players['Full_Name_Norm'].apply(lambda x: any(s in x for s in starters_list) or any(x in s for s in starters_list))
            merged_df.loc[team_players[mask].index, 'Is_Starter'] = True
        
        # B. Safety Fill (Top 5 Proj if < 5 found)
        current_starters_count = merged_df[(merged_df['team'] == team) & (merged_df['Is_Starter'] == True)].shape[0]
        if current_starters_count < 5:
            needed = 5 - current_starters_count
            candidates = merged_df[(merged_df['team'] == team) & (merged_df['Is_Starter'] == False)]
            candidates = candidates.sort_values('ppg_projection', ascending=False)
            fillers = candidates.head(needed)
            merged_df.loc[fillers.index, 'Is_Starter'] = True

    # 5. BUILD JSON
    data_export = {
        "last_updated": datetime.datetime.now().strftime("%Y-%m-%d %I:%M %p"),
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
        opp = team_row.iloc[0]['opp']
        
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
            # Sort: Starters First, then Position, then Projection
            team_subset = merged_df[merged_df['team'] == current_team].copy()
            team_subset = team_subset.sort_values(
                by=['Is_Starter', 'Pos_Rank', 'ppg_projection'], 
                ascending=[False, True, False]
            )
            
            # Clamp to Top 5
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
