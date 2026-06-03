import os
import re
import time
import asyncio
import requests
import unicodedata
import smtplib
from email.message import EmailMessage
from playwright.async_api import async_playwright
from moviepy.editor import VideoFileClip, AudioFileClip, CompositeAudioClip

# ==========================================
# CONFIGURATION & INPUTS
# ==========================================
ELEVENLABS_API_KEY = os.environ.get("ELEVENLABS_API_KEY")
TARGET_TEAM = os.environ.get("TARGET_TEAM")
TARGET_DATE = os.environ.get("TARGET_DATE")

# The Hype Announcer Voice
VOICE_ID = "6dcFFb31LVaCdYevmTAx"
OUTPUT_DIR = "data/lineup_videos"
AUDIO_DIR = "data/audio_clips"
os.makedirs(OUTPUT_DIR, exist_ok=True)
os.makedirs(AUDIO_DIR, exist_ok=True)

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

# The shorter nicknames to keep the cadence punchy
SHORT_NAMES = {
    "ATL": "Hawks", "BOS": "Celtics", "BKN": "Nets", "CHA": "Hornets", 
    "CHI": "Bulls", "CLE": "Cavaliers", "DAL": "Mavericks", "DEN": "Nuggets", 
    "DET": "Pistons", "GSW": "Warriors", "HOU": "Rockets", "IND": "Pacers", 
    "LAC": "Clippers", "LAL": "Lakers", "MEM": "Grizzlies", "MIA": "Heat", 
    "MIL": "Bucks", "MIN": "Timberwolves", "NOP": "Pelicans", "NYK": "Knicks", 
    "OKC": "Thunder", "ORL": "Magic", "PHI": "76ers", "PHX": "Suns", 
    "POR": "Trail Blazers", "SAC": "Kings", "SAS": "Spurs", "TOR": "Raptors", 
    "UTA": "Jazz", "WAS": "Wizards"
}

# ==========================================
# FUNCTIONS
# ==========================================

async def record_nba_video():
    print(f"🎥 Recording NBA Finals Game 1 Dual-Court for {TARGET_TEAM}...")
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            viewport={'width': 1080, 'height': 1920},
            record_video_dir=OUTPUT_DIR,
            record_video_size={"width": 1080, "height": 1920}
        )
        page = await context.new_page()
        
        url = f"https://nbastartingfive.com/tiktok_nba_card.html?date={TARGET_DATE}&team={TARGET_TEAM}"

        await page.goto(url, wait_until="networkidle")
        
        await page.evaluate("""
            const controls = document.getElementById('controls');
            if(controls) {
                controls.style.display = 'none';
            }
        """)
        
        # Timeline climax is at 56s. Give it 5 seconds to hold on the final text.
        print("⏳ Waiting 61 seconds for CSS animations to finish...")
        await asyncio.sleep(61)
        
        video_path = await page.video.path()
        await context.close()
        await browser.close()
        return video_path

def generate_single_clip(text, filename):
    """Hits ElevenLabs API for a single phrase and saves it."""
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}"
    headers = {
        "Accept": "audio/mpeg",
        "Content-Type": "application/json",
        "xi-api-key": ELEVENLABS_API_KEY
    }
    payload = {
        "text": text,
        "model_id": "eleven_multilingual_v2",
        "voice_settings": {
            "stability": 0.5,
            "similarity_boost": 0.75
        }
    }
    
    filepath = os.path.join(AUDIO_DIR, filename)
    
    try:
        response = requests.post(url, json=payload, headers=headers)
        if response.status_code == 200:
            with open(filepath, "wb") as f:
                f.write(response.content)
            return filepath
        else:
            print(f"❌ ElevenLabs API Error {response.status_code} for text '{text}': {response.text}")
            return None
    except Exception as e:
        print(f"❌ Audio Generation Failed for '{text}': {e}")
        return None

def build_audio_timeline():
    print("🎙️ Generating PA Announcer Audio Timeline...")
    
    try:
        data = requests.get(f"https://nbastartingfive.com/data/{TARGET_DATE}.json").json()
        games = data.get('games', [])
        target_game = next((g for g in games if TARGET_TEAM in g.get('teams', [])), None)
        
        away_team = target_game['teams'][0]
        home_team = target_game['teams'][1]
        
        away_roster = target_game['rosters'][away_team]['players'][:5]
        home_roster = target_game['rosters'][home_team]['players'][:5]
    except Exception as e:
        print(f"❌ Failed to fetch rosters for audio script: {e}")
        return None

    away_full = NBA_NAMES.get(away_team, away_team)
    home_full = NBA_NAMES.get(home_team, home_team)
    
    away_short = SHORT_NAMES.get(away_team, away_team)
    home_short = SHORT_NAMES.get(home_team, home_team)

    # Master list of tuples: (Timestamp, TextToSpeak, Filename)
    script_timeline = [
        # Isolated "Three-Punch" Intro Sequence for NBA Finals
        (0.5, "ARE YOU READY?! It's Game 1 of the NBA Finals!", "intro_1.mp3"),
        (5.5, f"The {away_full}...", "intro_2.mp3"),
        (8.0, f"...versus the {home_full}.", "intro_3.mp3")
    ]

    SPOKEN_POSITIONS = ["Point Guard", "Shooting Guard", "Small Forward", "Power Forward", "Center"]
    AWAY_LEAD_INS = ["At Point Guard", "At Shooting Guard", "At Small Forward", "At Power Forward", "And in the middle"]
    HOME_LEAD_INS = ["Matching up", "Countering", "Facing off", "Answering", "Matching up"]

    for i in range(5):
        away_name = away_roster[i].get('name', 'Unknown')
        home_name = home_roster[i].get('name', 'Unknown')
        
        away_parts = away_name.split(" ", 1)
        away_shout = f"{away_parts[0]}... {away_parts[1].upper()}!" if len(away_parts) > 1 else f"{away_name}!"
        
        home_parts = home_name.split(" ", 1)
        home_shout = f"{home_parts[0]}... {home_parts[1].upper()}!" if len(home_parts) > 1 else f"{home_name}!"

        # Away Team (Top) - Starts at 11.0s
        away_time = 11.0 + (i * 9.0)
        script_timeline.append((away_time, f"{AWAY_LEAD_INS[i]} for the {away_short}... {away_shout}", f"away_{i}.mp3"))

        # Home Team (Bottom) - Offset by 4.5 seconds
        home_time = 15.5 + (i * 9.0)
        script_timeline.append((home_time, f"{HOME_LEAD_INS[i]} for the {home_short}... {home_shout}", f"home_{i}.mp3"))

    # Outro hits exactly when the lights come on at 56s
    script_timeline.append((56.0, "Who will take the first step... to the ring?", "outro.mp3"))

    # Process all clips
    audio_assets = []
    print(f"Generating {len(script_timeline)} individual audio files...")
    for start_time, text, filename in script_timeline:
        time.sleep(0.5)
        print(f"  -> Generating: [{start_time}s] '{text}'")
        filepath = generate_single_clip(text, filename)
        if filepath:
            audio_assets.append((start_time, filepath))

    return audio_assets

def create_final_tiktok(silent_video_path, audio_assets):
    print("🎬 Stitching video and precision audio timeline together...")
    final_output = os.path.join(OUTPUT_DIR, f"{TARGET_TEAM}_{TARGET_DATE}_game1_finals.mp4")
    
    try:
        video_clip = VideoFileClip(silent_video_path)
        
        audio_layers = []
        clip_references = []
        
        for start_time, filepath in audio_assets:
            if os.path.exists(filepath):
                clip = AudioFileClip(filepath).set_start(start_time)
                audio_layers.append(clip)
                clip_references.append(clip)
        
        if audio_layers:
            final_audio = CompositeAudioClip(audio_layers)
            final_video = video_clip.set_audio(final_audio)
        else:
            final_video = video_clip
            
        final_video.write_videofile(final_output, codec="libx264", audio_codec="aac", fps=30, logger=None)
        
        video_clip.close()
        for c in clip_references:
            c.close()
            
        for _, filepath in audio_assets:
            if os.path.exists(filepath):
                os.remove(filepath)
        if os.path.exists(silent_video_path): 
            os.remove(silent_video_path)
        
        print(f"🏆 Final NBA Finals Game 1 Video ready: {final_output}")
        return final_output
    except Exception as e:
        print(f"❌ Video Stitching Failed: {e}")
        return None

def email_video(video_path):
    print("📧 Attempting to email the video...")
    
    sender_email = os.environ.get("GMAIL_ADDRESS") 
    app_password = os.environ.get("GMAIL_APP_PASSWORD")
    target_email = os.environ.get("TARGET_EMAIL", sender_email)

    if not sender_email or not app_password:
        print("⚠️ Missing GMAIL_ADDRESS or GMAIL_APP_PASSWORD. Skipping email delivery.")
        return

    msg = EmailMessage()
    msg['Subject'] = f"🏀 NBA Finals Game 1 Hype Video: {TARGET_TEAM}"
    msg['From'] = sender_email
    msg['To'] = target_email
    msg.set_content(f"Your NBA Finals Game 1 TikTok dual-court video for {TARGET_TEAM} has been generated and is attached!")

    try:
        file_size_mb = os.path.getsize(video_path) / (1024 * 1024)
        if file_size_mb > 25:
            print(f"❌ Video is {file_size_mb:.1f}MB (over Gmail's 25MB limit). Cannot email.")
            return

        with open(video_path, 'rb') as f:
            video_data = f.read()
            msg.add_attachment(video_data, maintype='video', subtype='mp4', filename=os.path.basename(video_path))

        with smtplib.SMTP_SSL('smtp.gmail.com', 465) as smtp:
            smtp.login(sender_email, app_password)
            smtp.send_message(msg)
            
        print("✅ Email sent successfully!")
    except Exception as e:
        print(f"❌ Failed to send email: {e}")

# ==========================================
# EXECUTION
# ==========================================
if __name__ == "__main__":
    audio_assets = build_audio_timeline()
    raw_vid = asyncio.run(record_nba_video())
    
    if raw_vid and audio_assets:
        final_mp4 = create_final_tiktok(raw_vid, audio_assets)
        if final_mp4:
            email_video(final_mp4)
