import os
import re
import time
import asyncio
import requests
import unicodedata
from playwright.async_api import async_playwright
from moviepy.editor import VideoFileClip, AudioFileClip, CompositeAudioClip
import moviepy.audio.fx.all as afx

# ==========================================
# CONFIGURATION & INPUTS
# ==========================================
ELEVENLABS_API_KEY = os.environ.get("ELEVENLABS_API_KEY")
TARGET_TEAM = os.environ.get("TARGET_TEAM")
TARGET_SIDE = os.environ.get("TARGET_SIDE")
TARGET_DATE = os.environ.get("TARGET_DATE")
#QvlD90AkjGTCqc9685Rq hype
#6dcFFb31LVaCdYevmTAx  announcer
#VOICE_ID = "JBFqnCBsd6RMkjVDRZzb" # Standard deep announcer voice
VOICE_ID = "6dcFFb31LVaCdYevmTAx"
OUTPUT_DIR = "data/lineup_videos"
os.makedirs(OUTPUT_DIR, exist_ok=True)

# Basic dictionary to expand names for the AI announcer
NBA_NAMES = {
    "ATL": "Atlanta Hawks", "BOS": "Boston Celtics", "BKN": "Brooklyn Nets", "CHA": "Charlotte Hornets", 
    "CHI": "Chicago Bulls", "CLE": "Cleveland Cavaliers", "DAL": "Dallas Mavericks", "DEN": "Denver Nuggets", 
    "DET": "Detroit Pistons", "GSW": "Golden State Warriors", "HOU": "Houston Rockets", "IND": "Indiana Pacers", 
    "LAC": "LA Clippers", "LAL": "Los Angeles Lakers", "MEM": "Memphis Grizzlies", "MIA": "Miami Heat", 
    "MIL": "Milwaukee Bucks", "MIN": "Minnesota Timberwolves", "NOP": "New Orleans Pelicans", "NYK": "New York Knicks", 
    "OKC": "Oklahoma City Thunder", "ORL": "Orlando Magic", "PHI": "Philadelphia 76ers", "PHX": "Phoenix Suns", 
    "POR": "Portland Trail Blazers", "SAC": "Sacramento Kings", "SAS": "San Antonio Spurs", "TOR": "Toronto Raptors", 
    "UTA": "Utah Jazz", "WAS": "Washington Wizards"
}

# Dictionary to expand state abbreviations into spoken words
STATE_NAMES = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California",
    "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware", "FL": "Florida", "GA": "Georgia",
    "HI": "Hawaii", "ID": "Idaho", "IL": "Illinois", "IN": "Indiana", "IA": "Iowa",
    "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland",
    "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota", "MS": "Mississippi", "MO": "Missouri",
    "MT": "Montana", "NE": "Nebraska", "NV": "Nevada", "NH": "New Hampshire", "NJ": "New Jersey",
    "NM": "New Mexico", "NY": "New York", "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio",
    "OK": "Oklahoma", "OR": "Oregon", "PA": "Pennsylvania", "RI": "Rhode Island", "SC": "South Carolina",
    "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas", "UT": "Utah", "VT": "Vermont",
    "VA": "Virginia", "WA": "Washington", "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming",
    "DC": "Washington D.C."
}

# ==========================================
# FUNCTIONS
# ==========================================

def normalize_name(name):
    """Matches the JavaScript text normalization to perfectly sync with your players.json"""
    nfkd = unicodedata.normalize('NFKD', name)
    clean = u"".join([c for c in nfkd if not unicodedata.combining(c)])
    return clean.lower().replace('.', '').strip()

def get_player_data(player_name, players_db):
    """3-Pass Fuzzy Match logic, identical to your HTML file!"""
    if not player_name: return {}
    
    nicknames = {"cam": "cameron", "cameron": "cam", "steph": "stephen", "stephen": "steph", "trey": "trae", "mo": "mohamed", "mohamed": "mo", "nico": "nicolas", "nicolas": "nico"}
    target_clean = normalize_name(player_name)
    parts = target_clean.split(" ")
    first_name = parts[0]
    last_name = " ".join(parts[1:])
    
    # PASS 1: Strict Exact Matches
    for key, pdata in players_db.items():
        db_name = normalize_name(pdata.get('name', ''))
        db_short = normalize_name(pdata.get('short_name', ''))
        if target_clean in [db_name, db_short]:
            return pdata
            
    # PASS 2: Nicknames
    if nicknames.get(first_name):
        nick_variant = f"{nicknames[first_name]} {last_name}"
        for key, pdata in players_db.items():
            db_name = normalize_name(pdata.get('name', ''))
            db_short = normalize_name(pdata.get('short_name', ''))
            if nick_variant in [db_name, db_short]:
                return pdata
                
    # PASS 3: Loose Match (The Kelly Oubre Fix!)
    if len(last_name) > 2:
        for key, pdata in players_db.items():
            db_name = normalize_name(pdata.get('name', ''))
            if last_name in db_name and db_name.startswith(first_name[0]):
                return pdata
                
    return {}

async def record_nba_video():
    print(f"🎥 Recording NBA Intro for {TARGET_TEAM}...")
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            viewport={'width': 1080, 'height': 1080},
            record_video_dir=OUTPUT_DIR,
            record_video_size={"width": 1080, "height": 1080}
        )
        page = await context.new_page()
        
        url = f"https://nbastartingfive.com/tiktok_nba_card.html?date={TARGET_DATE}&team={TARGET_TEAM}&side={TARGET_SIDE}"
        await page.goto(url, wait_until="networkidle")
        
        await page.evaluate("""
            const controls = document.getElementById('controls');
            if(controls) {
                controls.style.display = 'none';
            }
        """)
        
        print("⏳ Waiting 46 seconds for CSS animations to finish...")
        await asyncio.sleep(46)
        
        video_path = await page.video.path()
        await context.close()
        await browser.close()
        return video_path

def generate_announcer_audio():
    print("🎙️ Generating PA Announcer Audio...")
    
    try:
        data = requests.get(f"https://nbastartingfive.com/data/{TARGET_DATE}.json").json()
        games = data.get('games', [])
        target_game = next((g for g in games if TARGET_TEAM in g.get('teams', [])), None)
        roster = target_game['rosters'][TARGET_TEAM]['players'][:5]
    except Exception as e:
        print(f"❌ Failed to fetch roster for audio script: {e}")
        return None

    players_db = {}
    try:
        players_url = f"https://nbastartingfive.com/data/players.json?v={time.time()}"
        players_db = requests.get(players_url).json()
    except Exception as e:
        print(f"⚠️ Could not load players.json: {e}")

    full_name = NBA_NAMES.get(TARGET_TEAM, TARGET_TEAM)
    script = f"And now... the starting lineup for your... {full_name}! "
    
    SPOKEN_POSITIONS = ["Point Guard", "Shooting Guard", "Small Forward", "Power Forward", "Center"]
    
    for i, player in enumerate(roster):
        spoken_pos = SPOKEN_POSITIONS[i] if i < len(SPOKEN_POSITIONS) else "Flex"
        raw_name = player.get('name', 'Unknown')
        
        # 🚨 USE THE NEW FUZZY LOOKUP FUNCTION
        db_player = get_player_data(raw_name, players_db)
                    
        jersey = db_player.get('jersey', '')
        
        espn_id = ""
        if 'athlete' in db_player and isinstance(db_player['athlete'], dict):
            espn_id = db_player['athlete'].get('id', '')
            
        if not espn_id:
            espn_id = db_player.get('espn_id') or db_player.get('id', '')
        
        college_or_home = ""
        spoken_height = ""

        if espn_id:
            try:
                espn_url = f"http://site.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/{espn_id}"
                espn_headers = {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                }
                espn_response = requests.get(espn_url, headers=espn_headers)
                
                if espn_response.status_code == 200:
                    athlete_data = espn_response.json().get('athlete', {})
                    college_or_home = athlete_data.get('college', {}).get('name', '')
                    
                    if not college_or_home:
                        raw_birth_place = athlete_data.get('displayBirthPlace', '')
                        if raw_birth_place:
                            bp_parts = [p.strip() for p in raw_birth_place.split(',')]
                            if len(bp_parts) > 1:
                                possible_state = bp_parts[-1].upper()
                                if possible_state in STATE_NAMES:
                                    bp_parts[-1] = STATE_NAMES[possible_state]
                                    college_or_home = ", ".join(bp_parts)
                                else:
                                    college_or_home = raw_birth_place
                            else:
                                college_or_home = raw_birth_place
                        
                    raw_height = athlete_data.get('displayHeight', '')
                    if raw_height:
                        spoken_height = raw_height.replace("'", " foot").replace('"', '').strip()
                else:
                    print(f"⚠️ ESPN API blocked the request for {raw_name} (Error {espn_response.status_code})")
                    
            except Exception as e:
                print(f"⚠️ Could not fetch ESPN data for {raw_name}: {e}")
        else:
            print(f"⚠️ Could not locate ESPN ID for {raw_name} in players.json")

        # 🚨 THE HEIGHT FALLBACK: If ESPN failed, pull height straight from the players.json!
        if not spoken_height and db_player.get('height'):
            spoken_height = db_player.get('height').replace("'", " foot").replace('"', '').strip()

        script += f"At {spoken_pos}... "
        if spoken_height:
            script += f"standing at {spoken_height}... "
        if college_or_home:
            script += f"out of {college_or_home}... "
        if jersey:
            script += f"number {jersey}... "
        script += f"{raw_name}! "
        
    print(f"📜 Final Script: {script}")
    
    try:
        url = f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}"
        headers = {
            "Accept": "audio/mpeg",
            "Content-Type": "application/json",
            "xi-api-key": ELEVENLABS_API_KEY
        }
        payload = {
            "text": script,
            "model_id": "eleven_multilingual_v2",
            "voice_settings": {
                "stability": 0.5,
                "similarity_boost": 0.75
            }
        }
        
        response = requests.post(url, json=payload, headers=headers)
        
        if response.status_code == 200:
            audio_path = os.path.join(OUTPUT_DIR, f"{TARGET_TEAM}_audio.mp3")
            with open(audio_path, "wb") as f:
                f.write(response.content)
            print("✅ Audio generated successfully!")
            return audio_path
        else:
            print(f"❌ API Error {response.status_code}: {response.text}")
            return None
            
    except Exception as e:
        print(f"❌ Audio Generation Failed: {e}")
        return None

def create_final_tiktok(silent_video_path, voiceover_path):
    print("🎬 Stitching video and audio together with dynamic crowd noise...")
    final_output = os.path.join(OUTPUT_DIR, f"{TARGET_TEAM}_{TARGET_DATE}_hype.mp4")
    
    try:
        video_clip = VideoFileClip(silent_video_path)
        voice_clip = AudioFileClip(voiceover_path)
        
        audio_layers = [voice_clip]
        crowd_path = "data/crowd_cheer.mp3" 
        
        if os.path.exists(crowd_path):
            print("🏟️ Adding crowd noise swells...")
            raw_crowd = AudioFileClip(crowd_path)
            full_crowd = afx.audio_loop(raw_crowd, duration=video_clip.duration)
            
            base_crowd = full_crowd.volumex(0.1)
            audio_layers.append(base_crowd)
            
            swell_times = [4.11, 10.93, 18.15, 26.17, 31.72, 38.87]
            
            for swell in swell_times:
                end_time = min(swell + 3.0, video_clip.duration)
                if swell < video_clip.duration:
                    cheer = full_crowd.subclip(swell, end_time)
                    cheer = cheer.volumex(0.4).audio_fadein(0.5).audio_fadeout(0.5)
                    cheer = cheer.set_start(swell)
                    audio_layers.append(cheer)
        else:
            print("⚠️ No crowd_cheer.mp3 found in data folder. Skipping crowd noise.")
        
        final_audio = CompositeAudioClip(audio_layers)
        final_video = video_clip.set_audio(final_audio)
        final_video.write_videofile(final_output, codec="libx264", audio_codec="aac", fps=30, logger=None)
        
        video_clip.close()
        voice_clip.close()
        if 'raw_crowd' in locals():
            raw_crowd.close()
        
        if os.path.exists(silent_video_path): os.remove(silent_video_path)
        if os.path.exists(voiceover_path): os.remove(voiceover_path)
        
        print(f"🏆 Final Hype Video ready: {final_output}")
    except Exception as e:
        print(f"❌ Video Stitching Failed: {e}")

# ==========================================
# EXECUTION
# ==========================================
if __name__ == "__main__":
    raw_vid = asyncio.run(record_nba_video())
    audio_file = generate_announcer_audio()
    if raw_vid and audio_file:
        create_final_tiktok(raw_vid, audio_file)
