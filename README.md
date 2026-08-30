# 🎨 THE SPACE: Real-Time Art Gallery & Auction Platform

A modern, full-stack web application for viewing artwork, participating in live auctions, and engaging in real-time, multi-language discussions.

## 🚀 Live Demo
[Click here to view the live project](https://your-live-link-here.com) *(Update this once deployed!)*

## ✨ Features
- **Real-Time Bidding:** Live WebSocket-powered auction system with instant price updates.
- **Multi-Language Support:** Automatic, server-side translation of comments into the user's preferred language (supports EN, FR, ES, JA, ZH, AR, DE).
- **Voice Comments:** Built-in Speech-to-Text allowing users to dictate comments, which are then translated and broadcasted.
- **Text-to-Speech:** AI-powered audio playback of translated comments.
- **Persistent Data:** SQLite database integration ensures comments and bids are saved permanently.
- **Responsive UI:** Premium, dark-mode aesthetic designed for desktop and mobile.

## 🛠️ Tech Stack
- **Frontend:** HTML5, CSS3, Vanilla JavaScript (Web Speech API, WebSocket API)
- **Backend:** Python, FastAPI, Uvicorn
- **Database:** SQLite
- **Translation:** `deep-translator` (Google Translate API)

## 📂 Project Structure
```text
├── backend/
│   ├── server.py          # FastAPI server (WebSockets + HTTP endpoints)
│   ├── gallery.db         # SQLite database (ignored in git)
│   └── requirements.txt   # Python dependencies
├── artwork-detail.html    # Artwork viewing & commenting page
├── artwork-detail.js      # Frontend logic for comments, voice, and translation
├── artwork-detail.css     # Styling for detail page
├── auction.html           # Live auction interface
├── auction.js             # Real-time bidding logic
├── auction.css            # Styling for auction page
├── settings.html          # User preference page (Language selection)
└── README.md              # You are here!

## ⚙️ How to Run Locally

1. **Clone the repository:**
   ```bash
   git clone https://github.com/YOUR_USERNAME/the-space.git
   cd the-space

2. Setup the python backend
   ``` bash
   cd backend
   python -m venv venv
   source venv/bin/activate  # On Windows use: venv\Scripts\activate
   pip install -r requirements.txt
   python server.py

The server will start on http://localhost:8000

3  Open the frontend:
   Open index.html or auction.html in your web browser. (Note: For Voice features, use Google Chrome or Microsoft Edge).

🤝 Contributing
Feel free to fork this repository and submit pull requests for new features!

📜 License
This project is licensed under the MIT License.


### 💡 Why it looks like this:
- The ````bash` and ```` at the start and end of the commands tell GitHub to create those nice, dark gray code boxes.
- The `#` symbols create the headers.
- The `*` symbols make the text italic.

Just paste that exact block into your `README.md`, change `YOUR_USERNAME` to your actual GitHub username, and you are good to go! 🚀