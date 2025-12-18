import pandas as pd
import json
import glob
import os
import datetime
import requests
import sys
import re
# --- FIX: Added timedelta import here ---
from datetime import datetime as dt, timedelta

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
    'bub': 'carrinton',
    'greg': 'gregory',
    'nick': 'nicholas',
    'mitch': 'mitchell'
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
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(response.text, 'html.parser')
        
        rows = soup.find_all('tr')
        
        current_time = "TBD"
        
        for row in rows:
            cols = [c.get_text(strip=True) for c in row.find_all(['td', 'th'])]
            if not cols: continue
            
            # --- HEADER ROW DETECTION ---
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
                if not starters: continue
                
                active_teams = list(starters.keys())[-2:] 
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
    dff_df['norm_last'] = dff_df['last_name'].str.lower().str.strip
