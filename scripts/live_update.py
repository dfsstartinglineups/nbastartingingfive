import json
import os
import requests
import zoneinfo
from datetime import datetime

# ==========================================================
# --- FOLDER SETUP ---
# ==========================================================
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(SCRIPT_DIR, '..', 'data')
LIVE_DIR = os.path.join(DATA_DIR, 'LIVE')

# Ensure the LIVE directory exists
os.makedirs(LIVE_DIR, exist_ok=True)

# Standard Team Abbreviations
TEAM_MAP = {
    'GS': 'GSW', 'NO': 'NOP', 'NY': 'NYK', 'SA': 'SAS', 
    'PHO': 'PHX', 'UT': 'UTA', 'WSH': 'WAS', 'BKO': 'BKN', 'CHO': 'CHA'
}

def normalize_team(abbr):
    if not abbr: return ""
    clean = abbr.strip().upper()
    return TEAM_MAP.get(clean, clean)

def calculate_fpts(stats):
    """Calculates FD and DK Fantasy Points dynamically"""
    try: pts = float(stats.get('PTS', 0))
    except: pts = 0.0
    try: reb = float(stats.get('REB', 0))
    except: reb = 0.0
    try: ast = float(stats.get('AST', 0))
    except: ast = 0.0
    try: blk = float(stats.get('BLK', 0))
    except: blk = 0.0
    try: stl = float(stats.get('STL', 0))
    except: stl = 0.0
    try: to = float(stats.get('TO', 0))
    except: to = 0.0
    
    try: 
        threepm = float(stats.get('3PT', '0-0').split('-')[0])
    except: 
        threepm = 0.0

    # FanDuel Math
    fd_pts = pts + (reb * 1.2) + (ast * 1.5) + (blk * 3) + (stl * 3) - to
    
    # DraftKings Math
    dk_pts = pts + (threepm * 0.5) + (reb * 1.25) + (ast * 1.5) + (blk * 2) + (stl * 2) - (to * 0.5)
    
    # DK Bonuses (Double-Double / Triple-Double)
    doubles = 0
    for stat in [pts, reb, ast, blk, stl]:
        if stat >= 10:
            doubles += 1
            
    if doubles >= 3:
        dk_pts += 3.0 # Triple-Double Bonus
    elif doubles == 2:
        dk_pts += 1.5 # Double-Double Bonus

    return round(fd_pts, 2), round(dk_pts, 2)

def main():
    ny_tz = zoneinfo.ZoneInfo("America/New_York")
    now_est = datetime.now(ny_tz)
    
    current_date_str = now_est.strftime("%Y-%m-%d")
    espn_date_str = now_est.strftime("%Y%m%d")
    
    base_file_path = os.path.join(DATA_DIR, f"{current_date_str}.json")
    live_file_path = os.path.join(LIVE_DIR, f"live_{current_date_str}.json")
    
    # 1. Fetch live ESPN Scoreboard
    scoreboard_url = f"https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates={espn_date_str}"
    try:
        sb_res = requests.get(scoreboard_url, timeout=10)
        scoreboard_data = sb_res.json()
    except Exception as e:
        print(f"Failed to fetch ESPN scoreboard: {e}")
        return

    # 2. Load previous Live State (for Minute-Delta)
    live_state = {}
    if os.path.exists(live_file_path):
        try:
            with open(live_file_path, 'r') as f:
                live_state = json.load(f)
        except: pass

    # 3. Load Base JSON (for Tip-Off Starters Seed)
    base_json = {}
    if os.path.exists(base_file_path):
        try:
            with open(base_file_path, 'r') as f:
                base_json = json.load(f)
        except: pass
        
    # Helper to grab starting lineups from the base JSON
    def get_base_starters(local_game_id):
        starters = set()
        game_data = next((g for g in base_json.get('games', []) if g['id'] == local_game_id), None)
        if game_data:
            for s in game_data.get('homeStarters', []):
                starters.add(s.get('athlete', {}).get('displayName', ''))
            for s in game_data.get('awayStarters', []):
                starters.add(s.get('athlete', {}).get('displayName', ''))
        return starters

    new_live_data = {}
    active_games_found = 0

    for event in scoreboard_data.get('events', []):
        status_state = event['status']['type']['state']
        
        # Process games that are Live ('in') or just finished ('post')
        if status_state in ['in', 'post']:
            game_id = event['id']
            comp = event['competitions'][0]
            
            home_abbr = normalize_team(comp['competitors'][0]['team']['abbreviation'])
            away_abbr = normalize_team(comp['competitors'][1]['team']['abbreviation'])
            local_game_id = f"{away_abbr}-{home_abbr}-{current_date_str}"
            
            clock_text = event['status']['type']['shortDetail']
            
            print(f"Processing Live Game: {away_abbr} @ {home_abbr} ({clock_text})")
            active_games_found += 1
            
            # Fetch Game Summary (Boxscore)
            summary_url = f"https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event={game_id}"
            try:
                sum_res = requests.get(summary_url, timeout=10)
                box_data = sum_res.json()
            except: continue
            
            game_live_obj = {
                "status": status_state,
                "clock": clock_text,
                "team_stats": {},
                "players": {home_abbr: {}, away_abbr: {}}
            }
            
            base_starters = get_base_starters(local_game_id)
            prev_game_state = live_state.get(local_game_id, {})
            
            # Process Boxscore
            if 'boxscore' in box_data and 'players' in box_data['boxscore']:
                for team_box in box_data['boxscore']['players']:
                    t_abbr = normalize_team(team_box['team']['abbreviation'])
                    if not team_box.get('statistics'): continue
                    
                    stat_labels = team_box['statistics'][0]['names']
                    team_athletes = team_box['statistics'][0]['athletes']
                    
                    # Minute-Delta Check: Did anyone on this team gain minutes?
                    team_minutes_increased = False
                    for ath in team_athletes:
                        if not ath.get('stats'): continue
                        p_name = ath['athlete']['displayName']
                        mapped_stats = dict(zip(stat_labels, ath['stats']))
                        
                        try: current_mins = int(mapped_stats.get('MIN', 0))
                        except: current_mins = 0
                            
                        prev_mins = prev_game_state.get("players", {}).get(t_abbr, {}).get(p_name, {}).get("MIN", 0)
                        if current_mins > prev_mins:
                            team_minutes_increased = True
                            break
                            
                    # Build Player Objects
                    for ath in team_athletes:
                        if not ath.get('stats'): continue
                        p_name = ath['athlete']['displayName']
                        mapped_stats = dict(zip(stat_labels, ath['stats']))
                        
                        try: current_mins = int(mapped_stats.get('MIN', 0))
                        except: current_mins = 0
                            
                        prev_player_data = prev_game_state.get("players", {}).get(t_abbr, {}).get(p_name, {})
                        prev_mins = prev_player_data.get("MIN", 0)
                        was_on_court = prev_player_data.get("is_on_court", False)
                        
                        is_on_court = False
                        
                        # LOGIC 1: Minute Delta Check
                        if current_mins > prev_mins:
                            is_on_court = True
                        # LOGIC 2: Timeout/Halftime Freeze (No one gained minutes)
                        elif not team_minutes_increased and current_mins > 0:
                            is_on_court = was_on_court
                        # LOGIC 3: Tip-Off Seed (Game just started, mins are 0)
                        elif current_mins == 0 and not team_minutes_increased:
                            if p_name in base_starters:
                                is_on_court = True
                                
                        fd_pts, dk_pts = calculate_fpts(mapped_stats)
                        
                        game_live_obj["players"][t_abbr][p_name] = {
                            "MIN": current_mins,
                            "PTS": mapped_stats.get("PTS", "0"),
                            "REB": mapped_stats.get("REB", "0"),
                            "AST": mapped_stats.get("AST", "0"),
                            "STL": mapped_stats.get("STL", "0"),
                            "BLK": mapped_stats.get("BLK", "0"),
                            "TO": mapped_stats.get("TO", "0"),
                            "FG": mapped_stats.get("FG", "0-0"),
                            "3PT": mapped_stats.get("3PT", "0-0"),
                            "FT": mapped_stats.get("FT", "0-0"),
                            "fd_pts": fd_pts,
                            "dk_pts": dk_pts,
                            "is_on_court": is_on_court
                        }
                        
            # Grab Team Stats (Shooting splits, totals, etc.)
            if 'boxscore' in box_data and 'teams' in box_data['boxscore']:
                for team_box in box_data['boxscore']['teams']:
                    t_abbr = normalize_team(team_box['team']['abbreviation'])
                    if not team_box.get('statistics'): continue
                    
                    team_stats_dict = {}
                    # Team stats are a flat list of dictionaries, not a matrix
                    for stat_obj in team_box['statistics']:
                        stat_key = stat_obj.get('abbreviation', stat_obj.get('name', ''))
                        stat_val = stat_obj.get('displayValue', '')
                        if stat_key:
                            team_stats_dict[stat_key] = stat_val
                            
                    game_live_obj["team_stats"][t_abbr] = team_stats_dict

            new_live_data[local_game_id] = game_live_obj

    if active_games_found > 0:
        # Save it purely to the LIVE folder
        with open(live_file_path, 'w') as f:
            json.dump(new_live_data, f, indent=2)
        print(f"\n✅ Successfully updated {live_file_path} with {active_games_found} active games.")
    else:
        print("\n💤 No active games right now. Script exiting cleanly.")

if __name__ == "__main__":
    main()
