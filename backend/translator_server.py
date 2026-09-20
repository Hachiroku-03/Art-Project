from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from deep_translator import GoogleTranslator, MyMemoryTranslator
from langdetect import detect, LangDetectException
import time
import hashlib
import threading

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

CACHE = {}
CACHE_LOCK = threading.Lock()

LOCALE_MAP = {
    'es': 'es-ES', 'fr': 'fr-FR', 'de': 'de-DE', 'it': 'it-IT',
    'pt': 'pt-PT', 'ru': 'ru-RU', 'zh': 'zh-CN', 'ja': 'ja-JP',
    'ko': 'ko-KR', 'ar': 'ar-SA', 'hi': 'hi-IN', 'nl': 'nl-NL',
    'en': 'en-GB',
}

def mm_code(target: str) -> str:
    return LOCALE_MAP.get(target, f"{target}-{target.upper()}")

def detect_source_lang(text: str) -> str:
    """Detects the language of the text and returns the MyMemory-compatible code."""
    try:
        code = detect(text)
        # Map detected codes to MyMemory's preferred format
        mapping = {
            'en': 'en-GB', 'es': 'es-ES', 'fr': 'fr-FR', 'de': 'de-DE',
            'it': 'it-IT', 'ja': 'ja-JP', 'zh-cn': 'zh-CN', 'zh-tw': 'zh-TW',
            'ru': 'ru-RU', 'pt': 'pt-PT', 'ko': 'ko-KR', 'ar': 'ar-SA'
        }
        return mapping.get(code, f"{code}-{code.upper()}")
    except LangDetectException:
        return 'en-GB' # Fallback if detection fails

def cache_key(text: str, target: str) -> str:
    return hashlib.sha1(f"{target}::{text}".encode()).hexdigest()

def try_google(text: str, target: str) -> str:
    return GoogleTranslator(source='auto', target=target).translate(text)

def try_mymemory(text: str, target: str) -> str:
    # THE FIX: Detect the source language dynamically
    source = detect_source_lang(text)
    target_code = mm_code(target)
    return MyMemoryTranslator(source=source, target=target_code).translate(text)

ENGINES = [("google", try_google), ("mymemory", try_mymemory)]

def safe_translate(text: str, target: str) -> str:
    if not text or not text.strip():
        return text
    key = cache_key(text, target)
    with CACHE_LOCK:
        if key in CACHE:
            return CACHE[key]
    for name, fn in ENGINES:
        try:
            result = fn(text, target)
            if result and result.strip() and result != text:
                with CACHE_LOCK:
                    CACHE[key] = result
                print(f"[Translator] {name} served ({target})")
                return result
        except Exception as e:
            print(f"[Translator] {name} failed: {str(e)[:140]}")
    print("[Translator] all engines failed - returning original")
    return text

@app.get("/health")
def health():
    report = {}
    sample = "The gallery is open."
    for name, fn in ENGINES:
        try:
            report[name] = {"status": "ok", "sample": fn(sample, "es")}
        except Exception as e:
            report[name] = {"status": "error", "reason": str(e)[:200]}
    return {"engines": report, "cache_size": len(CACHE)}

@app.post("/translate")
def translate(data: dict):
    text = (data.get("text") or "").strip()
    target = data.get("target") or "en"
    if not text:
        return {"error": "text required"}
    return {"translation": safe_translate(text, target)}

@app.post("/translate_many")
def translate_many(data: dict):
    texts = data.get("texts") or []
    target = data.get("target") or "en"
    if not texts:
        return {"error": "texts required"}
    results = []
    for text in texts:
        was_cached = cache_key(text, target) in CACHE
        results.append(safe_translate(text, target))
        if not was_cached:
            time.sleep(0.25)
    return {"translations": results}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8002)