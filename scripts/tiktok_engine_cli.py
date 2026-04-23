import os
import time
import asyncio
import requests
from playwright.async_api import async_playwright
from moviepy.editor import VideoFileClip, AudioFileClip

# ==========================================
# CONFIGURATION & INPUTS
# ==========================================
ELEVENLABS_API_KEY = os.environ.get("ELEVENLABS_API_KEY")
TARGET_TEAM = os.environ.get("TARGET_TEAM")
TARGET_SIDE = os.environ.get("TARGET_SIDE")
TARGET_DATE = os.environ.get("TARGET_DATE")
VOICE_ID = "JBFqnCBsd6RMkjVDRZzb" # Standard deep announcer voice

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

# ==========================================
# FUNCTIONS
# ==========================================
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
        
        # Point to your live site (make sure this is the file with the animations!)
        url = f"https://nbastartingfive.com/tiktok_nba_card.html?date={TARGET_DATE}&team={TARGET_TEAM}&side={TARGET_SIDE}"
        await page.goto(url, wait_until="networkidle")
        
        print("⏳ Waiting 26 seconds for CSS animations to finish...")
        # Increased to 26 to ensure the Center's animation finishes and we get a nice 3-second hold at the end
        await asyncio.sleep(26)
        
        video_path = await page.video.path()
        await context.close()
        await browser.close()
        return video_path

def generate_announcer_audio():
    print("🎙️ Generating PA Announcer Audio...")
    
    # 1. Fetch the live roster from your site
    try:
        data = requests.get(f"https://nbastartingfive.com/data/{TARGET_DATE}.json").json()
        games = data.get('games', [])
        target_game = next((g for g in games if TARGET_TEAM in g.get('teams', [])), None)
        roster = target_game['rosters'][TARGET_TEAM]['players'][:5]
    except Exception as e:
        print(f"❌ Failed to fetch roster for audio script: {e}")
        return None

    # 2. Fetch your players.json to get Jerseys and ESPN IDs
    players_db = {}
    try:
        players_url = f"https://nbastartingfive.com/data/players.json?v={time.time()}"
        players_db = requests.get(players_url).json()
    except Exception as e:
        print(f"⚠️ Could not load players.json: {e}")

    # 3. Build the Ultimate Script
    full_name = NBA_NAMES.get(TARGET_TEAM, TARGET_TEAM)
    script = f"And now... the starting lineup for your... {full_name}! "
    
    SPOKEN_POSITIONS = ["Point Guard", "Shooting Guard", "Small Forward", "Power Forward", "Center"]
    nicknames = {"cam": "cameron", "cameron": "cam", "steph": "stephen", "stephen": "steph", "trey": "trae", "mo": "mohamed", "mohamed": "mo", "nico": "nicolas", "nicolas": "nico"}
    
    for i, player in enumerate(roster):
        spoken_pos = SPOKEN_POSITIONS[i] if i < len(SPOKEN_POSITIONS) else "Flex"
        raw_name = player.get('name', 'Unknown')
        target_clean = normalize_name(raw_name)
        
        # Extract first and last name for nickname matching
        parts = target_clean.split(" ")
        first_name = parts[0]
        last_name = " ".join(parts[1:])
        
        # Search players.json for a match
        db_player = {}
        for key, pdata in players_db.items():
            db_name = normalize_name(pdata.get('name', ''))
            db_short = normalize_name(pdata.get('short_name', ''))
            
            # Pass 1: Strict Match
            if target_clean in [db_name, db_short]:
                db_player = pdata
                break
            
            # Pass 2: Nickname Match
            if nicknames.get(first_name):
                nick_variant = f"{nicknames[first_name]} {last_name}"
                if nick_variant in [db_name, db_short]:
                    db_player = pdata
                    break
                    
        jersey = db_player.get('jersey', '')
        espn_id = db_player.get('espn_id', '')
        college_or_home = ""
        spoken_height = ""

        # Hit ESPN specifically for this player's college and height using their exact ID
        if espn_id:
            try:
                espn_url = f"http://site.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/{espn_id}"
                athlete_data = requests.get(espn_url).json().get('athlete', {})
                
                # Grab College or Birthplace
                college_or_home = athlete_data.get('college', {}).get('name', '')
                if not college_or_home:
                    college_or_home = athlete_data.get('displayBirthPlace', '')
                    
                # Grab Height and format it for Text-to-Speech (e.g. 6' 9" -> 6 foot 9)
                raw_height = athlete_data.get('displayHeight', '')
                if raw_height:
                    spoken_height = raw_height.replace("'", " foot").replace('"', '').strip()
                    
            except Exception as e:
                print(f"⚠️ Could not fetch ESPN data for {raw_name}: {e}")

        # Assemble the final string for this player
        script += f"At {spoken_pos}... "
        if spoken_height:
            script += f"standing at {spoken_height}... "
        if college_or_home:
            script += f"out of {college_or_home}... "
        if jersey:
            script += f"number {jersey}... "
        script += f"{raw_name}! "
        
    print(f"📜 Final Script: {script}")
    
    # 4. Call ElevenLabs API
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
    print("🎬 Stitching video and audio together...")
    final_output = os.path.join(OUTPUT_DIR, f"{TARGET_TEAM}_{TARGET_DATE}_hype.mp4")
    
    try:
        video_clip = VideoFileClip(silent_video_path)
        voice_clip = AudioFileClip(voiceover_path)
        
        final_video = video_clip.set_audio(voice_clip)
        final_video.write_videofile(final_output, codec="libx264", audio_codec="aac", fps=30, logger=None)
        
        video_clip.close()
        voice_clip.close()
        
        # Clean up the raw files so they don't get committed to GitHub
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
