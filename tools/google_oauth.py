"""One-time Google sign-in so the LuxSync Worker can download as the folders' owner.

Google caps how often a link-shared file can be downloaded *anonymously*
(LS-DRV-FILE). The owner's own read-only access isn't capped that way, so with
these credentials the Worker downloads (and scans watched folders) as you,
falling back to the public API key if anything about the sign-in fails.

Before running (Google Cloud console, the project that owns DRIVE_API_KEY):
  1. APIs & Services > OAuth consent screen: user type **Internal** (Workspace),
     so the sign-in never expires after 7 days. Add the scope
     .../auth/drive.readonly.
  2. Credentials > Create credentials > OAuth client ID > **Desktop app**.
     Download the JSON and save it as secrets/google-oauth-client.json.

Then, from the repo root:
    python tools/google_oauth.py
Sign in in the browser window with the account that owns the client folders
(juliancheung@accurova.com). It writes secrets/luxsync-google-oauth.json; load
it into the Worker from worker/:
    npx wrangler secret bulk ../secrets/luxsync-google-oauth.json

Standard library only. No token is ever printed.
"""
import base64
import hashlib
import http.server
import json
import os
import secrets
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
CLIENT_FILE = os.path.join(ROOT, "secrets", "google-oauth-client.json")
OUT_FILE = os.path.join(ROOT, "secrets", "luxsync-google-oauth.json")
SCOPE = "https://www.googleapis.com/auth/drive.readonly"


def load_client():
    if not os.path.exists(CLIENT_FILE):
        sys.exit(f"Save the OAuth client JSON (Desktop app) as {os.path.normpath(CLIENT_FILE)} first.")
    with open(CLIENT_FILE, encoding="utf-8") as f:
        data = json.load(f)
    c = data.get("installed") or data.get("web") or data
    if not c.get("client_id") or not c.get("client_secret"):
        sys.exit("That file has no client_id / client_secret. Download the client JSON again (type: Desktop app).")
    return c["client_id"], c["client_secret"]


def post_form(url, fields):
    req = urllib.request.Request(url, data=urllib.parse.urlencode(fields).encode(), method="POST",
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.load(res)
    except urllib.error.HTTPError as e:
        detail = json.loads(e.read() or b"{}")
        sys.exit(f"Google refused the sign-in: {detail.get('error', e.code)} {detail.get('error_description', '')}")


def get_json(url, token):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.load(res)


def main():
    client_id, client_secret = load_client()
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(16)
    result = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            if q.get("state", [""])[0] != state:
                self.send_response(400); self.end_headers(); return
            result["code"] = q.get("code", [""])[0]
            result["error"] = q.get("error", [""])[0]
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"LuxSync: signed in. You can close this tab and go back to the terminal.")

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    redirect = f"http://127.0.0.1:{server.server_port}"
    url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
        "client_id": client_id, "redirect_uri": redirect, "response_type": "code", "scope": SCOPE,
        "access_type": "offline", "prompt": "consent", "state": state,
        "code_challenge": challenge, "code_challenge_method": "S256",
    })
    print("Opening the Google sign-in page. If it doesn't open, paste this into a browser:\n" + url + "\n")
    webbrowser.open(url)
    thread = threading.Thread(target=server.handle_request)
    thread.start()
    thread.join(timeout=300)
    server.server_close()
    if result.get("error") or not result.get("code"):
        sys.exit(f"Sign-in didn't complete ({result.get('error') or 'timed out after 5 minutes'}).")

    tokens = post_form("https://oauth2.googleapis.com/token", {
        "code": result["code"], "client_id": client_id, "client_secret": client_secret,
        "redirect_uri": redirect, "grant_type": "authorization_code", "code_verifier": verifier,
    })
    if not tokens.get("refresh_token"):
        sys.exit("Google returned no refresh token. Remove LuxSync's access at myaccount.google.com/permissions and run this again.")
    who = get_json("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)", tokens["access_token"])
    email = who.get("user", {}).get("emailAddress", "?")

    os.makedirs(os.path.dirname(OUT_FILE), exist_ok=True)
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump({"GOOGLE_CLIENT_ID": client_id, "GOOGLE_CLIENT_SECRET": client_secret,
                   "GOOGLE_REFRESH_TOKEN": tokens["refresh_token"]}, f, indent=2)
    print(f"Signed in as {email}. Saved {os.path.normpath(OUT_FILE)} (git-ignored).")
    print("Next, from worker/:  npx wrangler secret bulk ../secrets/luxsync-google-oauth.json")


if __name__ == "__main__":
    main()
