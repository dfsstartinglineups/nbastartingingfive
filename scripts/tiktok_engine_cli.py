import os
import time
import asyncio
import requests
from playwright.async_api import async_playwright
from elevenlabs.client import ElevenLabs
from elevenlabs import save
from moviepy.editor import VideoFileClip, AudioFileClip

# ==========================================
# CONFIGURATION & INPUTS
# ==========================================
ELEVENLABS_API_KEY = os.environ.get("ELEVENLABS_API_KEY")
TARGET_TEAM = os.environ.get("TARGET_TEAM")
TARGET_SIDE = os.environ.get("TARGET_SIDE")
TARGET_DATE = os.environ.get("TARGET_DATE")
VOICE_ID = "pNInz6obbfdqCwg9h8XD" # Standard deep announcer voice

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
        
        print("⏳ Waiting 22 seconds for CSS animations to finish...")
        await asyncio.sleep(22)
        
        video_path = await page.video.path()
        await context.close()
        await browser.close()
        return video_path

def generate_announcer_audio():
    print("🎙️ Generating PA Announcer Audio...")
    client = ElevenLabs(api_key=ELEVENLABS_API_KEY)
    
    # Fetch the live roster to get the names for the script
    try:
        data = requests.get(f"https://nbastartingfive.com/data/{TARGET_DATE}.json").json()
        games = data.get('games', [])
        target_game = next((g for g in games if TARGET_TEAM in g.get('teams', [])), None)
        roster = target_game['rosters'][TARGET_TEAM]['players'][:5]
    except Exception as e:
        print(f"Failed to fetch roster for audio script: {e}")
        return None

    full_name = NBA_NAMES.get(TARGET_TEAM, TARGET_TEAM)
    script = f"And now... the starting lineup for your... {full_name}! "
    for player in roster:
        pos = player.get('pos', 'Flex')
        name = player.get('name', 'Unknown')
        script += f"At {pos}... {name}... "
        
    try:
        audio = client.generate(text=script, voice=VOICE_ID, model="eleven_multilingual_v2")
        audio_path = os.path.join(OUTPUT_DIR, f"{TARGET_TEAM}_audio.mp3")
        save(audio, audio_path)
        return audio_path
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
