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
            
            # --- HEADER ROW ---
            is_header = False
            raw_away, raw_home, potential_time = "", "", ""

            if len(cols_text) >= 3:
                if "@" in cols_text[2]:
                    potential_time = cols_text[0]
                    raw_away, raw_home = cols_text[1], cols_text[2]
                    is_header = True
                elif "@" in cols_text[1]:
                    potential_time = "7:00 PM"
                    raw_away, raw_home = cols_text[0], cols_text[1]
                    is_header = True
            
            if is_header:
                game_time = "7:00 PM"
                if ':' in potential_time and ('am' in potential_time.lower() or 'pm' in potential_time.lower()):
                    game_time = potential_time.upper()
                
                team_away = normalize_team(raw_away.replace('@', '').strip())
                team_home = normalize_team(raw_home.replace('@', '').strip())
                
                if team_away not in starters: starters[team_away] = []
                if team_home not in starters: starters[team_home] = []
                
                game_times[team_away] = game_time
                game_times[team_home] = game_time
                continue
            
            # --- PLAYER ROW (Look for Links) ---
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
                        # DEBUG PRINT
                        print(f"RAW WEB: Found {clean} for {tm_away} (from '{raw}')")

                # Check Home Link
                link_home = cells[2].find('a', href=True)
                if link_home and 'playerinfo.aspx' in link_home['href']:
                    raw = link_home.get_text(strip=True)
                    clean = clean_player_name(raw)
                    if clean: 
                        starters[tm_home].append(clean)
                        # DEBUG PRINT
                        print(f"RAW WEB: Found {clean} for {tm_home} (from '{raw}')")

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
            print(f"Skipping {team}: No web
