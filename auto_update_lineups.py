import pandas as pd
import json
import glob
import os
import requests
import re
import zoneinfo
from datetime import datetime, timezone, timedelta

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
    clean_name = re.sub(r'[\r\n\t\d\xa0]', '', str(team_name)).strip().upper()
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

# --- NEW: FETCH PRECISE DATES & TIMES FROM ESPN ---
def get_espn_schedule_data():
    print("--- Fetching true game dates and times from ESPN ---")
    team_schedule = {}
    try:
        ny_tz = zoneinfo.ZoneInfo("America/New_York")
        now_est = datetime.now(ny_tz)
        
        # Check today, tomorrow, and the next day
        for i in range(3):
            target_date = now_est + timedelta(days=i)
            date_str = target_date.strftime('%Y%m%d')
            
            url = f"https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates={date_str}"
            res = requests.get(url, timeout=10)
            data = res.json()
            
            for ev in data.get('events', []):
                # ESPN gives dates in UTC ISO format (e.g. 2026-03-10T00:30Z)
                utc_date_str = ev['date'].replace('Z', '+00:00')
                dt_utc = datetime.fromisoformat(utc_date_str)
                dt_est = dt_utc.astimezone(ny_tz)
                
                local_date_format = dt_est.strftime('%Y-%m-%d')
                local_time_format = dt_est.strftime('%I:%M %p').lstrip('0') # Strips leading zero from hour
                
                for comp in ev['competitions'][0]['competitors']:
                    team_abbr = normalize_team(comp['team']['abbreviation'])
                    # Only map it the FIRST time we see them (their immediate next game)
                    if team_abbr not in team_schedule:
                        team_schedule[team_abbr] = {
                            "date": local_date_format,
                            "time": local_time_format
                        }
    except Exception as e:
        print(f"ESPN Date/Time Fetch Error: {e}")
    return team_schedule

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
    
    for row in rows:
        cells = row.find_all(['td', 'th'])
        cols_text = [c.get_text(strip=True) for c in cells]
        
        if not cols_text: continue
        
        is_header = False
        raw_away, raw_home = "", ""
        
        if len(cols_text) >= 3:
            if "@" in cols_text[2]: 
                raw_away, raw_home = cols_text[1], cols_text[2]
                is_header = True
            elif "@" in cols_text[1]: 
                raw_away, raw_home = cols_text[0], cols_text[1]
                is_header = True
        
        if is_header:
            team_away = normalize_team(raw_away.replace('@', ''))
            team_home = normalize_team(raw_home.replace('@', ''))

            if team_away not in starters_map: starters_map[team_away] = []
            if team_home not in starters_map: starters_map[team_home] = []
            continue

        if len(cols_text) >= 3 and cols_text[0] in ['PG', 'SG', 'SF', 'PF', 'C']:
            if not starters_map: continue
            
            active_teams = list(starters_map.keys())[-2:]
            tm_away = active_teams[0]
            tm_home = active_teams[1]
            
            def extract_player_info(cell):
                link = cell.find('a', href=True)
                if link and 'playerinfo.aspx' in link['href']:
                    name = link.get_text(strip=True)
                    classes = cell.get('class', [])
                    is_verified = 'verified' in classes
                    return {'name': name, 'verified': is_verified}
                return None

            if len(starters_map[tm_away]) < 5:
                p_info = extract_player_info(cells[1])
                if p_info: starters_map[tm_away].append(p_info)

            if len(starters_map[tm_home]) < 5:
                p_info = extract_player_info(cells[2])
                if p_info: starters_map[tm_home].append(p_info)

    print(f"Scraped {len(starters_map)} teams.")
    return starters_map

# --- STEP 2: LOAD CSV ---
def load_cheat_sheet():
    files = glob.glob('*DFF*.csv')
    if not files:
        return pd.DataFrame()
    
    path = sorted(files)[-1]
    
    try:
        df = pd.read_csv(path)
        df['norm_team'] = df['team'].apply(normalize_team)
        if 'first_name' in df.columns and 'last_name' in df.columns:
            df['clean_name'] = df.apply(lambda x: clean_player_name(f"{x['first_name']} {x['last_name']}"), axis=1)
            df['last_name_lower'] = df['last_name'].str.lower().str.strip()
            df['first_initial'] = df['first_name'].str[0].str.lower()
        return df
    except Exception as e:
        return pd.DataFrame()

# --- STEP 3: MAIN LOGIC ---
def build_json():
    # Setup timezone perfectly for Daylight Saving Time using zoneinfo
    ny_tz = zoneinfo.ZoneInfo("America/New_York")
    et_now = datetime.now(ny_tz)
    current_date_str = et_now.strftime("%Y-%m-%d")
    yesterday_str = (et_now - timedelta(days=1)).strftime("%Y-%m-%d")
    valid_dates = [current_date_str, yesterday_str]
    
    old_memory = {}
    if os.path.exists('nba_data.json'):
        try:
            with open('nba_data.json', 'r') as f:
                old_data = json.load(f)
                for g in old_data.get('games', []):
                    clean_id = str(g['id']).replace('\r', '').replace('\n', '').replace(' ', '')
                    g_date = g.get("date_added", current_date_str)
                    if g_date in valid_dates:
                        g['date_added'] = g_date 
                        old_memory[clean_id] = g
        except: pass

    # Get the real dates and times from ESPN!
    team_schedule = get_espn_schedule_data()

    scraped_rosters = scrape_starters()
    stats_df = load_cheat_sheet()
    
    teams_list = list(scraped_rosters.keys())
    new_games_dict = {}
    formatted_time = et_now.strftime("%b %d, %I:%M %p ET")
    
    print("\n--- MATCHING PLAYERS ---")

    for i in range(0, len(teams_list), 2):
        if i+1 >= len(teams_list): break
        
        team_a = teams_list[i]
        team_b = teams_list[i+1]
        
        # Fetch exact Date and Time from ESPN map
        schedule_info = team_schedule.get(team_a) or team_schedule.get(team_b, {})
        game_date = schedule_info.get("date", current_date_str)
        game_time = schedule_info.get("time", "TBD")
        
        # Unique ID combining Teams + ESPN Date
        game_id = f"{team_a}-{team_b}-{game_date}"
        
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

        old_game = old_memory.get(game_id, {})
        old_meta = old_game.get("meta", {})
        
        if spread_str in ["TBD", "nan", "+nan"] or pd.isna(spread_str):
            old_s = str(old_meta.get("spread", "TBD"))
            if old_s not in ["TBD", "nan", "+nan", "None"]:
                spread_str = old_s
                
        if total_str in ["TBD", "nan", "+nan"] or pd.isna(total_str):
            old_t = str(old_meta.get("total", "TBD"))
            if old_t not in ["TBD", "nan", "+nan", "None"]:
                total_str = old_t

        game_obj = {
            "id": game_id,
            "date": game_date, 
            "date_added": current_date_str, 
            "teams": [team_a, team_b],
            "meta": {
                "spread": spread_str,
                "total": total_str,
                "time": game_time  # Injected directly from ESPN
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
                
                p_data = {
                    "pos": "Flex", "name": raw_name,
                    "salary": 0, "proj": 0, "value": 0,
                    "injury": "", "verified": is_verified 
                }
                
                if not stats_df.empty:
                    match = stats_df[(stats_df['norm_team'] == team) & (stats_df['clean_name'] == clean)]
                    
                    if match.empty:
                        parts = clean.split()
                        if len(parts) >= 2:
                            match = stats_df[
                                (stats_df['norm_team'] == team) & 
                                (stats_df['last_name_lower'] == parts[-1]) &
                                (stats_df['first_initial'] == parts[0][0])
                            ]
                    
                    if not match.empty:
                        row = match.iloc[0]
                        try:
                            sal = float(row['salary'])
                            proj = float(row['ppg_projection'])
                            p_data = {
                                "pos": row['position'],
                                "name": f"{row['first_name']} {row['last_name']}",
                                "salary": int(sal),
                                "proj": round(proj, 1),
                                "value": round(proj / (sal/1000), 2) if sal > 0 else 0,
                                "injury": str(row['injury_status']) if pd.notna(row['injury_status']) else "",
                                "verified": is_verified
                            }
                        except: pass
                
                player_list.append(p_data)
            
            if not player_list:
                 player_list.append({"pos": "-", "name": "Waiting for Lineup", "salary": 0, "proj": 0, "value": 0, "injury": "", "verified": False})

            game_obj['rosters'][team] = {
                "logo": f"https://a.espncdn.com/i/teamlogos/nba/500/{team.lower()}.png",
                "players": player_list
            }
            
        new_games_dict[game_id] = game_obj

    for g_id, g_obj in new_games_dict.items():
        old_memory[g_id] = g_obj
        
    games_output = list(old_memory.values())

    # Sort strictly by the precise ESPN time
    for g in games_output:
        g['sort_index'] = parse_time_to_minutes(g['meta'].get('time', '7:00 PM'))
        
    games_output.sort(key=lambda x: x['sort_index'])
    
    for g in games_output: 
        if 'sort_index' in g:
            del g['sort_index']
    
    final_json = {
        "last_updated": formatted_time,
        "games": games_output
    }
    
    with open('nba_data.json', 'w') as f:
        json.dump(final_json, f, indent=2)
    
    print(f"SUCCESS. Generated {len(games_output)} games (Combined Active & Completed).")

if __name__ == "__main__":
    build_json()
