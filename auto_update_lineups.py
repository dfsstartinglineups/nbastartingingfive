import pandas as pd
import json
import glob
import os
import datetime
import requests
from bs4 import BeautifulSoup

# URL to scrape for confirmed starters
ROTOWIRE_URL = "https://www.rotowire.com/basketball/nba-lineups.php"

# Headers to look like a real browser
HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
}

def get_confirmed_starters_from_web():
    print(f"Fetching confirmed starters from {ROTOWIRE_URL}...")
    confirmed_starters = {} 
    
    try:
        response = requests.get(ROTOWIRE_URL, headers=HEADERS, timeout=10)
        if response.status_code != 200:
            print(f"Failed to fetch website. Status Code: {response.status_code}")
            return {}
            
        soup = BeautifulSoup(response.text, 'html.parser')
        lineup_boxes = soup.find_all(class_='lineup')
        
        print(f"Found {len(lineup_boxes)} games on the web schedule.")
        
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
        print(f"Error scraping web: {e}")
        
    print(f"Scraped starters for {len(confirmed_starters)} teams.")
    return confirmed_starters

def build_json():
    print("--- Starting NBA Data Build ---")
    
    # FIND FILES AUTOMATICALLY
    dff_files = glob.glob('*DFF*.csv')
    fd_files = glob.glob('*FanDuel*.csv')
    
    if not dff_files or not fd_files:
        print("ERROR: Could not find both CSV files.")
        return

    dff_path = sorted(dff_files)[-1]
    fd_path = sorted(fd_files)[-1]
    print(f"Reading: {dff_path}")
    print(f"Reading: {fd_path}")

    # LOAD & MERGE
    try:
        dff_df = pd.read_csv(dff_path)
        fd_df = pd.read_csv(fd_path)
    except Exception as e:
        print(f"Error reading CSVs: {e}")
        return

    # Normalize Names
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
    
    # GET DYNAMIC STARTERS
    web_starters = get_confirmed_starters_from_web()
    web_starters_norm = {}
    for team, players in web_starters.items():
        norm_team = team.strip()
        web_starters_norm[norm_team] = [p.lower().strip() for p in players]

    merged_df['Full_Name'] = merged_df['first_name'] + " " + merged_df['last_name']
    merged_df['Full_Name_Norm'] = merged_df['Full_Name'].str.lower().str.strip()
    
    # Sort by Projection for fallback
    merged_df.sort_values(by=['team', 'ppg_projection'], ascending=[True, False], inplace=True)
    merged_df['Is_Starter'] = False
    
    unique_teams = merged_df['team'].unique()
    
    for team in unique_teams:
        team_players = merged_df[merged_df['team'] == team]
        starters_list = web_starters_norm.get(team, [])
        
        if starters_list:
            mask = team_players['Full_Name_Norm'].apply(lambda x: any(s in x for s in starters_list) or any(x in s for s in starters_list))
            if mask.any():
                print(f"[{team}] Using {mask.sum()} starters found on web.")
                merged_df.loc[team_players[mask].index, 'Is_Starter'] = True
            else:
                 print(f"[{team}] Web data found but no name matches. Using Projections.")
                 merged_df.loc[team_players.head(5).index, 'Is_Starter'] = True
        else:
            print(f"[{team}] No web data. Using Top 5 Projected.")
            merged_df.loc[team_players.head(5).index, 'Is_Starter'] = True

    # BUILD JSON
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
            starters = merged_df[
                (merged_df['team'] == current_team) & 
                (merged_df['Is_Starter'] == True)
            ].sort_values('Pos_Rank')
            
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