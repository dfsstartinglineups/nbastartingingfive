import json
import os
import requests
import zoneinfo
from datetime import datetime, timedelta

# ==========================================================
# --- FOLDER SETUP ---
# ==========================================================
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(SCRIPT_DIR, '..', 'data')
LIVE_DIR = os.path.join(DATA_DIR, 'LIVE')

os.makedirs(LIVE_DIR, exist_ok=True)

TEAM_MAP = {
    'GS': 'GSW', 'NO': 'NOP', 'NY': 'NYK', 'SA': 'SAS', 
    'PHO': 'PHX', 'UT': 'UTA', 'WSH': 'WAS', 'BKO': 'BKN', 'CHO': 'CHA',
    'UTAH': 'UTA'
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
    
    try: threepm = float(stats.get('3PT', '0-0').split('-')[0])
    except: threepm = 0.0

    fd_pts = pts + (reb * 1.2) + (ast * 1.5) + (blk * 3) + (stl * 3) - to
    dk_pts = pts + (threepm * 0.5) + (reb * 1.25) + (ast * 1.5) + (blk * 2) + (stl * 2) - (to * 0.5)
    
    doubles = sum(1 for stat in [pts, reb, ast, blk, stl] if stat >= 10)
    if doubles >= 3: dk_pts += 3.0 
    elif doubles == 2: dk_pts += 1.5 

    return round(fd_pts, 2), round(dk_pts, 2)

def resolve_espn_name(pbp_name, roster_names):
    """
    Strictly maps ESPN's Play-by-Play short names (e.g., 'I. Joe') 
    to ESPN's Boxscore full names (e.g., 'Isaiah Joe').
    """
    clean_pbp = pbp_name.replace('.', '').strip().lower()

    for full_name in roster_names:
        if clean_pbp == full_name.replace('.', '').strip().lower():
            return full_name
            
    parts = clean_pbp.split()
    if len(parts) > 1:
        pbp_first = parts[0]
        pbp_last = parts[-1]
        
        matching_initials = []
        for full_name in roster_names:
            clean_full = full_name.replace('.', '').strip().lower()
            full_parts = clean_full.split()
            compare_last = full_parts[-2] if full_parts[-1] in ['jr', 'sr', 'ii', 'iii', 'iv'] and len(full_parts) > 1 else full_parts[-1]
            
            if compare_last == pbp_last and clean_full.startswith(pbp_first[0]):
                matching_initials.append(full_name)
                
        if len(matching_initials) == 1:
            return matching_initials[0]
            
        matching_last_names = []
        for full_name in roster_names:
            clean_full = full_name.replace('.', '').strip().lower()
            full_parts = clean_full.split()
            compare_last = full_parts[-2] if full_parts[-1] in ['jr', 'sr', 'ii', 'iii', 'iv'] and len(full_parts) > 1 else full_parts[-1]
            
            if compare_last == pbp_last:
                matching_last_names.append(full_name)
                
        if len(matching_last_names) == 1:
            return matching_last_names[0]

    return None

def main():
    ny_tz = zoneinfo.ZoneInfo("America/New_York")
    now_est = datetime.now(ny_tz)
    
    # 🌙 MIDNIGHT ROLLOVER FIX: Offset the time by 4 hours to keep late games on the same "NBA Day"
    nba_day = now_est - timedelta(hours=4)
    
    current_date_str = nba_day.strftime("%Y-%m-%d")
    espn_date_str = nba_day.strftime("%Y%m%d")
    
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

    # 2. Load Base JSON (for Fallback Rosters)
    base_json = {}
    if os.path.exists(base_file_path):
        try:
            with open(base_file_path, 'r') as f:
                base_json = json.load(f)
        except: pass

    # 3. Load Previous Live JSON (To find where the Play-by-Play left off)
    old_live_data = {}
    if os.path.exists(live_file_path):
        try:
            with open(live_file_path, 'r') as f:
                old_live_data = json.load(f)
        except: pass

    new_live_data = {}
    active_games_found = 0

    for event in scoreboard_data.get('events', []):
        status_state = event['status']['type']['state']
        
        if status_state in ['in', 'post']:
            game_id = event['id']
            comp = event['competitions'][0]
            
            home_abbr = normalize_team(comp['competitors'][0]['team']['abbreviation'])
            away_abbr = normalize_team(comp['competitors'][1]['team']['abbreviation'])
            local_game_id = f"{away_abbr}-{home_abbr}-{current_date_str}"
            
            clock_text = event['status']['type']['shortDetail']
            
            away_score = comp['competitors'][1].get('score', '0')
            home_score = comp['competitors'][0].get('score', '0')
            
            print(f"Processing Live Game: {away_abbr} {away_score} @ {home_score} {home_abbr} ({clock_text})")
            active_games_found += 1
            
            # --- FETCH BOXSCORE AND PLAY-BY-PLAY (FROM SUMMARY) ---
            summary_url = f"https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event={game_id}"
            try:
                sum_res = requests.get(summary_url, timeout=10)
                box_data = sum_res.json()
            except: continue

            game_live_obj = {
                "status": status_state,
                "clock": clock_text,
                "away_score": away_score, 
                "home_score": home_score, 
                "team_stats": {},
                "players": {home_abbr: {}, away_abbr: {}}
            }
            
            # =========================================================
            # BUILD NATIVE ESPN ROSTERS & STARTERS
            # =========================================================
            rosters = {home_abbr: [], away_abbr: []}
            home_starters = set()
            away_starters = set()
            
            # DFS Fallback
            game_data = None
            for g in base_json.get('games', []):
                if g.get('teams') and len(g['teams']) >= 2:
                    t1, t2 = normalize_team(g['teams'][0]), normalize_team(g['teams'][1])
                    if (t1 == home_abbr or t1 == away_abbr) and (t2 == home_abbr or t2 == away_abbr):
                        game_data = g
                        break
            
            if game_data:
                for s in game_data.get('homeStarters', []) + game_data.get('homeBench', []):
                    rosters[home_abbr].append(s.get('athlete', {}).get('displayName', ''))
                for s in game_data.get('awayStarters', []) + game_data.get('awayBench', []):
                    rosters[away_abbr].append(s.get('athlete', {}).get('displayName', ''))

            # ESPN Native Boxscore
            if 'boxscore' in box_data and 'players' in box_data['boxscore']:
                for team_box in box_data['boxscore']['players']:
                    t_abbr = normalize_team(team_box['team']['abbreviation'])
                    if team_box.get('statistics'):
                        for ath in team_box['statistics'][0].get('athletes', []):
                            p_name = ath['athlete']['displayName']
                            if p_name not in rosters.get(t_abbr, []):
                                rosters[t_abbr].append(p_name)
                            
                            if ath.get('starter', False):
                                if t_abbr == home_abbr: home_starters.add(p_name)
                                elif t_abbr == away_abbr: away_starters.add(p_name)
            
            # Fallback Seed
            if not home_starters and len(rosters[home_abbr]) >= 5: home_starters = set(rosters[home_abbr][:5])
            if not away_starters and len(rosters[away_abbr]) >= 5: away_starters = set(rosters[away_abbr][:5])
            
            on_court_tracker = { home_abbr: home_starters, away_abbr: away_starters }
            unmatched_injections = { home_abbr: {}, away_abbr: {} }

            plays = box_data.get('plays', [])
            plays = sorted(plays, key=lambda x: float(x.get('sequenceNumber', 0)))
            
            # =========================================================
            # SMART PLAY-BY-PLAY DIFFING ENGINE
            # =========================================================
            old_game_data = old_live_data.get(local_game_id, {})
            old_pbp = old_game_data.get("play_by_play", {})
            last_seq = float(old_pbp.get("last_seq", 0))

            formatted_full = []
            formatted_new = []
            max_seq = last_seq

            for p in plays:
                seq = float(p.get('sequenceNumber', 0))
                clock_data = p.get('clock') or {}
                clock = clock_data.get('displayValue', '') if isinstance(clock_data, dict) else ''
                period_data = p.get('period') or {}
                period = period_data.get('number', '') if isinstance(period_data, dict) else ''
                text = p.get('text', '')
                
                # Format OT nicely based on Period number!
                if str(period).isdigit():
                    period_num = int(period)
                    if period_num == 5:
                        time_str = f"OT {clock}".strip()
                    elif period_num > 5:
                        time_str = f"{period_num - 4}OT {clock}".strip()
                    else:
                        time_str = f"Q{period_num} {clock}".strip()
                else:
                    time_str = clock
                
                play_obj = {
                    "seq": seq,
                    "period": period,
                    "time": time_str,
                    "text": text
                }
                
                formatted_full.append(play_obj)
                
                # Check if this play happened AFTER our last scrape!
                if seq > last_seq:
                    formatted_new.append(play_obj)
                    if seq > max_seq:
                        max_seq = seq

            game_live_obj["play_by_play"] = {
                "full_log": formatted_full[::-1], # Reversed so index 0 is the newest play
                "new_plays": formatted_new[::-1],
                "last_seq": max_seq
            }
            
            # =========================================================
            # PROCESS SUBSTITUTIONS
            # =========================================================
            for play in plays:
                text = play.get('text', '')
                if ' enters the game for ' in text:
                    parts = text.split(' enters the game for ')
                    if len(parts) == 2:
                        p_in_raw = parts[0].strip()
                        p_out_raw = parts[1].strip()
                        
                        if not p_in_raw or not p_out_raw: continue
                        
                        team_in, full_in = None, None
                        team_out, full_out = None, None
                        
                        for t_abbr in [home_abbr, away_abbr]:
                            if not team_in:
                                m_in = resolve_espn_name(p_in_raw, rosters[t_abbr])
                                if m_in: team_in, full_in = t_abbr, m_in
                            if not team_out:
                                m_out = resolve_espn_name(p_out_raw, rosters[t_abbr])
                                if m_out: team_out, full_out = t_abbr, m_out
                                
                        target_team = team_in or team_out
                        if target_team:
                            if not full_in:
                                in_val = f"{p_in_raw} (didn't match)"
                                unmatched_injections[target_team][in_val] = True
                            else:
                                in_val = full_in

                            if not full_out:
                                out_val = f"{p_out_raw} (didn't match)"
                                unmatched_injections[target_team][out_val] = False
                            else:
                                out_val = full_out
                                
                            if out_val in on_court_tracker[target_team]:
                                on_court_tracker[target_team].remove(out_val)
                            elif not full_out:
                                out_parts = p_out_raw.split()
                                if out_parts:
                                    for p in list(on_court_tracker[target_team]):
                                        if out_parts[-1].lower() in p.lower():
                                            on_court_tracker[target_team].remove(p)
                                            break
                                        
                            on_court_tracker[target_team].add(in_val)

            # THE BAND-AID PATCH
            for t_abbr in [home_abbr, away_abbr]:
                if len(on_court_tracker[t_abbr]) < 5:
                    for play in reversed(plays):
                        text = play.get('text', '')
                        if ' enters the game for ' in text: break 
                        
                        text_lower = text.lower()
                        for roster_player in rosters[t_abbr]:
                            if roster_player in on_court_tracker[t_abbr]: continue
                                
                            rp_lower = roster_player.lower()
                            is_match = False
                            if rp_lower in text_lower:
                                is_match = True
                            else:
                                parts = rp_lower.split()
                                last_name = parts[-2] if parts[-1] in ['jr.', 'sr.', 'ii', 'iii', 'iv', 'jr', 'sr'] and len(parts) > 1 else parts[-1]
                                if last_name in text_lower:
                                    same_last = sum(1 for p in rosters[t_abbr] if (p.lower().split()[-2] if p.lower().split()[-1] in ['jr.', 'sr.', 'ii', 'iii', 'iv', 'jr', 'sr'] and len(p.split())>1 else p.lower().split()[-1]) == last_name)
                                    if same_last == 1: is_match = True
                            
                            if is_match:
                                on_court_tracker[t_abbr].add(roster_player)
                                print(f"🩹 PATCH APPLIED: Found {roster_player} active, injected to {t_abbr} court.")
                                if len(on_court_tracker[t_abbr]) == 5: break
                        if len(on_court_tracker[t_abbr]) == 5: break

            # =========================================================
            # BUILD BOXSCORE JSON WITH NEW ON-COURT FLAGS
            # =========================================================
            if 'boxscore' in box_data and 'players' in box_data['boxscore']:
                for team_box in box_data['boxscore']['players']:
                    t_abbr = normalize_team(team_box['team']['abbreviation'])
                    if not team_box.get('statistics'): continue
                    
                    stat_labels = team_box['statistics'][0]['names']
                    team_athletes = team_box['statistics'][0]['athletes']
                    
                    for ath in team_athletes:
                        if not ath.get('stats'): continue
                        p_name = ath['athlete']['displayName']
                        mapped_stats = dict(zip(stat_labels, ath['stats']))
                        
                        try: current_mins = int(mapped_stats.get('MIN', 0))
                        except: current_mins = 0
                        
                        is_on_court = p_name in on_court_tracker[t_abbr]
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

            # INJECT MISSING/UNMATCHED PLAYERS FOR THE UI
            for t_abbr, court_set in on_court_tracker.items():
                for p_name in court_set:
                    if p_name not in game_live_obj["players"][t_abbr]:
                        game_live_obj["players"][t_abbr][p_name] = {
                            "MIN": 0, "PTS": "0", "REB": "0", "AST": "0", "STL": "0", "BLK": "0", "TO": "0",
                            "FG": "0-0", "3PT": "0-0", "FT": "0-0",
                            "fd_pts": 0.0, "dk_pts": 0.0,
                            "is_on_court": True
                        }
            
            for t_abbr, un_dict in unmatched_injections.items():
                for p_name, is_court in un_dict.items():
                    if p_name not in game_live_obj["players"][t_abbr]:
                        game_live_obj["players"][t_abbr][p_name] = {
                            "MIN": 0, "PTS": "0", "REB": "0", "AST": "0", "STL": "0", "BLK": "0", "TO": "0",
                            "FG": "0-0", "3PT": "0-0", "FT": "0-0",
                            "fd_pts": 0.0, "dk_pts": 0.0,
                            "is_on_court": is_court
                        }

            # Grab Team Stats
            if 'boxscore' in box_data and 'teams' in box_data['boxscore']:
                for team_box in box_data['boxscore']['teams']:
                    t_abbr = normalize_team(team_box['team']['abbreviation'])
                    if not team_box.get('statistics'): continue
                    
                    team_stats_dict = {}
                    for stat_obj in team_box['statistics']:
                        stat_key = stat_obj.get('abbreviation', stat_obj.get('name', ''))
                        stat_val = stat_obj.get('displayValue', '')
                        if stat_key:
                            team_stats_dict[stat_key] = stat_val
                            
                    game_live_obj["team_stats"][t_abbr] = team_stats_dict

            new_live_data[local_game_id] = game_live_obj

    if active_games_found > 0:
        with open(live_file_path, 'w') as f:
            json.dump(new_live_data, f, indent=2)
        print(f"\n✅ Successfully updated {live_file_path} with {active_games_found} active games.")
    else:
        print("\n💤 No active games right now. Script exiting cleanly.")

if __name__ == "__main__":
    main()
